// Minimal SSE framing over a fetch response body. EventSource is unusable here
// because it cannot send an Authorization header, so we parse the wire format
// ourselves. The server emits every frame as a bare `data:` line holding a JSON
// object with an internal `type` field, plus `: ping` comment keepalives every
// 15 s — so comment lines and unknown fields must be dropped silently.

/** Yields the `data` payload of each SSE record, in order. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // A record is terminated by a blank line; a frame may be split across
      // any number of chunks, so we only ever consume whole lines.
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n");
            data = [];
            yield payload;
          }
          continue;
        }
        if (line.startsWith(":")) continue; // keepalive comment
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        // `event:`/`id:`/`retry:` are never sent by this server; ignore them.
      }
    }
  } finally {
    // Cancelling lets an aborted fetch tear the socket down promptly; on an
    // already-errored stream it rejects, which is not our problem.
    void reader.cancel().catch(() => {});
  }
}
