// lib/runner/sprites-tunnel.ts
// Helpers for the Sprites TCP proxy → channel WebSocket tunnel.
// See docs/sprites-migration-design.md §5.

import { Duplex } from "node:stream";
import WebSocket from "ws";

import { config } from "../config";
import { parseSpritesDialEndpoint } from "../worker-channel/dispatch-env";

export type SpritesProxyTarget = NonNullable<ReturnType<typeof parseSpritesDialEndpoint>>;

/** Parse a logical `sprite://<name>:<port>/worker/channel` endpoint. Re-export of the canonical parser. */
export const parseSpritesTarget = parseSpritesDialEndpoint;

/** Build the WSS proxy URL for a sprite. */
export function spritesProxyUrl(spriteName: string, baseUrl: string = config.sprites.baseUrl): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/sprites/${encodeURIComponent(spriteName)}/proxy`;
}

/** Resolve the sprites API token. */
export function spritesToken(): string | undefined {
  return config.sprites.token;
}

/**
 * A Duplex that forwards writes as binary messages over a proxy WebSocket and
 * pushes incoming proxy messages as readable data. The proxy WebSocket is the
 * raw TCP relay after the JSON handshake.
 */
class ProxyTunnelDuplex extends Duplex {
  // Node net.Socket shims so this Duplex can be passed as `createConnection` to `ws`/`http`.
  // `ws`'s setSocket checks for their existence before calling; `http` uses them for timeouts.
  setTimeout = (_ms: number, _cb?: () => void): this => this;
  setNoDelay = (_noDelay?: boolean): this => this;
  setKeepAlive = (_enable?: boolean, _delay?: number): this => this;
  ref = (): this => this;
  unref = (): this => this;

  constructor(private readonly proxyWs: WebSocket) {
    super();
    this.proxyWs.on("message", (data: WebSocket.RawData) => {
      const buf = typeof data === "string" ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // The first post-handshake message might still be JSON status; if we
      // already handled handshake outside, all remaining messages are raw TCP bytes.
      // Push them as-is.
      if (!this.push(buf)) {
        // backpressure ignored for now; ws handles buffering
      }
    });
    this.proxyWs.on("close", () => this.push(null));
    this.proxyWs.on("error", (err) => this.destroy(err as Error));
  }

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    if (this.proxyWs.readyState !== WebSocket.OPEN) {
      cb(new Error("proxy socket not open"));
      return;
    }
    this.proxyWs.send(chunk, { binary: true }, (err) => cb(err as Error | null));
  }

  _read(): void {
    // no-op; push is driven by proxy messages
  }

  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    try {
      if (this.proxyWs.readyState === WebSocket.OPEN || this.proxyWs.readyState === WebSocket.CONNECTING) {
        this.proxyWs.close();
      }
    } catch {}
    cb(err);
  }
}

/**
 * Open a proxy tunnel to `host:port` inside `spriteName`.
 * Handshake: send {host,port} JSON, expect {status:"connected"} JSON.
 * Returns a Duplex that is the raw TCP relay.
 */
export async function openSpritesProxyTunnel(
  target: SpritesProxyTarget,
  opts: { token?: string; proxyUrl?: string; createSocket?: typeof WebSocket } = {},
): Promise<Duplex> {
  const token = opts.token ?? spritesToken();
  if (!token) throw new Error("SPRITES_TOKEN is required for sprites proxy dial");
  const url = opts.proxyUrl ?? spritesProxyUrl(target.spriteName);
  const WS = (opts.createSocket as unknown as typeof WebSocket) ?? WebSocket;

  const ws = new (WS as typeof WebSocket)(url, [], {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 10_000,
  } as WebSocket.ClientOptions);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy socket closed before open"));
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });

  // Perform JSON handshake
  const handshake = JSON.stringify({ host: "localhost", port: target.port });
  const connected = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("sprites proxy handshake timeout"));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
        const msg = JSON.parse(text);
        if (msg.status === "connected") {
          cleanup();
          resolve(true);
        } else {
          // Unexpected JSON — treat as failure
          cleanup();
          reject(new Error(`unexpected proxy handshake response: ${text}`));
        }
      } catch {
        // Non-JSON binary before handshake should not happen; ignore and wait for next message
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy socket closed during handshake"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
    ws.send(handshake);
  });

  if (!connected) throw new Error("sprites proxy handshake failed");
  // From now on, ws is raw relay — wrap as Duplex
  return new ProxyTunnelDuplex(ws);
}
