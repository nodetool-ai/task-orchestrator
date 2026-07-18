# Box Blank Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Box runs start on a blank box that downloads the worker bundle from the control plane and clones the run's own repo at launch — no template snapshot needed.

**Architecture:** Per `docs/superpowers/specs/2026-07-18-box-blank-provision-design.md`: (1) the control plane serves its own `dist/run-worker.standalone.js` via `GET /api/worker-bundle`, authenticated with the run-scoped worker-channel HMAC credential; (2) `BoxRunnerProvider.create()` in blank mode creates a blank box, runs one detached provision command (curl bundle + sha256 verify + `git clone --depth 1` the run's repo + write the standard template manifest), then hands off to the existing `readyAndLaunch` unchanged; (3) admission skips template gating in blank mode. Template mode stays as the rollback path behind `TASK_ORCH_BOX_PROVISION=template`.

**Tech Stack:** TypeScript, Next.js route handlers, Drizzle/Postgres, ascii.dev Box SDK, vitest.

## Global Constraints

- Mode env var: `TASK_ORCH_BOX_PROVISION`, values `blank` (default) | `template`; invalid values throw.
- Bundle URL: `TASK_ORCH_BUNDLE_URL` explicit override, else derived `${AUTH_URL without trailing slash}/api/worker-bundle`, else undefined (blank-mode `create()` fails actionably).
- Bundle served from `dist/run-worker.standalone.js` relative to `process.cwd()`; missing file → HTTP 503 whose body names `npm run build:worker:standalone`.
- Route auth: `Authorization: Bearer <channel credential>` + `X-Run-Id` header, verified via `verifyChannelCredential(token, runId, instanceId)` against the `runner_instances` row's `channelInstanceId`; an API token (`verifyToken`) or session (`auth()`) is also accepted (operator debugging). Response headers: `X-Bundle-Sha256`, `X-Worker-Sha`.
- Provision command: detached setsid + `.rc` polling (the template builder's pattern, extracted to a shared helper), budget `config.box.provisionTimeoutSeconds` (env `TASK_ORCH_BOX_PROVISION_TIMEOUT_S`, default 300).
- The provision command writes the standard manifest (`/home/user/.task-orchestrator/template.json`) with `workerBuildSha` = server's `workerBuildSha()`, `repository` = the run's `owner/repo`, `repositoryPath` = `config.box.repoPath ?? "/home/user/repository"`, `workerEntryPath` = `/home/user/worker/run-worker.js` — so `readyAndLaunch`, the bootstrap, and park/resume stay untouched.
- No secrets interpolated into command text server-side: `GH_TOKEN`, `TASK_ORCH_WORKER_CHANNEL_CREDENTIAL`, `TASK_ORCH_RUN_ID`, `TASK_ORCH_BUNDLE_URL` are expanded by the box's shell from its env.
- Test runner: `npx vitest run <file>`. Known pre-existing flakes (NOT regressions): `worker-websocket-e2e.test.ts` "wakes on a follow-up input", `placement-routing.test.ts` "resumeServerRun duplicate-wake short-circuit".
- Do not touch `app/plans/[id]/page.tsx`, `components/plan-chat-box.tsx`, `__tests__/worker-chat-box.test.ts` (pre-existing dirty files).

---

### Task 1: Bundle locator + config knobs

**Files:**
- Create: `lib/worker-bundle.ts`
- Modify: `lib/config.ts` (the `box:` block, ~line 425)
- Test: `__tests__/worker-bundle.test.ts`

**Interfaces:**
- Produces: `locateWorkerBundle(opts?: { path?: string }): { path: string; size: number; sha256: string } | null` — null when the file is missing; sha256 hex, cached keyed on `(path, mtimeMs, size)`.
- Produces config getters: `config.box.provisionMode: "blank" | "template"`, `config.box.bundleUrl: string | undefined`, `config.box.provisionTimeoutSeconds: number`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/worker-bundle.test.ts`:

```ts
// __tests__/worker-bundle.test.ts
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateWorkerBundle } from "../lib/worker-bundle";
import { config } from "../lib/config";

const KNOBS = ["TASK_ORCH_BOX_PROVISION", "TASK_ORCH_BUNDLE_URL", "AUTH_URL", "TASK_ORCH_BOX_PROVISION_TIMEOUT_S"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-bundle-"));
  saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  for (const k of KNOBS) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KNOBS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("locateWorkerBundle", () => {
  it("returns null when the bundle file does not exist", () => {
    expect(locateWorkerBundle({ path: join(dir, "nope.js") })).toBeNull();
  });

  it("returns path, size, and sha256 of the bundle", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "console.log('w')\n");
    const want = createHash("sha256").update("console.log('w')\n").digest("hex");
    const got = locateWorkerBundle({ path: p });
    expect(got).toMatchObject({ path: p, size: 17, sha256: want });
  });

  it("recomputes the hash when the file changes", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "one");
    const first = locateWorkerBundle({ path: p })!.sha256;
    writeFileSync(p, "two");
    utimesSync(p, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(locateWorkerBundle({ path: p })!.sha256).not.toBe(first);
  });
});

describe("box provisioning config", () => {
  it("defaults provisionMode to blank and rejects unknown values", () => {
    expect(config.box.provisionMode).toBe("blank");
    process.env.TASK_ORCH_BOX_PROVISION = "template";
    expect(config.box.provisionMode).toBe("template");
    process.env.TASK_ORCH_BOX_PROVISION = "wat";
    expect(() => config.box.provisionMode).toThrow(/TASK_ORCH_BOX_PROVISION/);
  });

  it("derives bundleUrl from AUTH_URL and prefers the explicit override", () => {
    expect(config.box.bundleUrl).toBeUndefined();
    process.env.AUTH_URL = "https://tasks.example.com/";
    expect(config.box.bundleUrl).toBe("https://tasks.example.com/api/worker-bundle");
    process.env.TASK_ORCH_BUNDLE_URL = "https://cdn.example.com/wb";
    expect(config.box.bundleUrl).toBe("https://cdn.example.com/wb");
  });

  it("defaults provisionTimeoutSeconds to 300", () => {
    expect(config.box.provisionTimeoutSeconds).toBe(300);
    process.env.TASK_ORCH_BOX_PROVISION_TIMEOUT_S = "120";
    expect(config.box.provisionTimeoutSeconds).toBe(120);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/worker-bundle.test.ts`
Expected: FAIL — cannot find module `../lib/worker-bundle`; config getters undefined.

- [ ] **Step 3: Implement**

Create `lib/worker-bundle.ts`:

```ts
// lib/worker-bundle.ts
//
// Locates the standalone worker bundle the control plane serves to blank-
// provisioned Box runners (spec: 2026-07-18-box-blank-provision-design.md §1).
// The sha256 is what the box verifies after download, so it is computed from
// the exact bytes on disk and cached only while (mtime, size) are unchanged.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BUNDLE_PATH = join(process.cwd(), "dist", "run-worker.standalone.js");

let cache: { path: string; mtimeMs: number; size: number; sha256: string } | null = null;

export function locateWorkerBundle(
  opts: { path?: string } = {}
): { path: string; size: number; sha256: string } | null {
  const path = opts.path ?? DEFAULT_BUNDLE_PATH;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return { path, size: cache.size, sha256: cache.sha256 };
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  return { path, size: stat.size, sha256 };
}
```

In `lib/config.ts`, inside the `box: Object.freeze({ ... })` block (after the `repoPath` getter), add:

```ts
    /** How a Box run is provisioned: "blank" (default — create a blank box,
     *  download the worker bundle from the control plane, clone the run's
     *  repo) or "template" (legacy — fork a pre-built template snapshot). */
    get provisionMode(): "blank" | "template" {
      const raw = strEnv("TASK_ORCH_BOX_PROVISION", "blank").trim().toLowerCase();
      if (raw === "blank" || raw === "template") return raw;
      throw new Error(`TASK_ORCH_BOX_PROVISION must be 'blank' or 'template', got '${raw}'.`);
    },
    /** Where a blank-provisioned box downloads the worker bundle. Explicit
     *  TASK_ORCH_BUNDLE_URL wins; else derived from AUTH_URL; else undefined
     *  (blank-mode dispatch fails with an actionable error). */
    get bundleUrl(): string | undefined {
      const explicit = strEnv("TASK_ORCH_BUNDLE_URL");
      if (explicit) return explicit;
      const base = strEnv("AUTH_URL");
      if (!base) return undefined;
      return `${base.replace(/\/+$/, "")}/api/worker-bundle`;
    },
    /** Budget for the blank-box provision command (download + clone + manifest). */
    get provisionTimeoutSeconds(): number {
      const value = intEnv("TASK_ORCH_BOX_PROVISION_TIMEOUT_S", 300);
      return value > 0 ? value : 300;
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/worker-bundle.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/worker-bundle.ts lib/config.ts __tests__/worker-bundle.test.ts
git commit -m "feat(box): worker-bundle locator and blank-provisioning config knobs"
```

---

### Task 2: `GET /api/worker-bundle` route

**Files:**
- Create: `app/api/worker-bundle/route.ts`
- Test: `__tests__/worker-bundle-route.test.ts`

**Interfaces:**
- Consumes: `locateWorkerBundle()` (Task 1), `verifyChannelCredential` (`lib/worker-channel/credential.ts`), `verifyToken` (`lib/api-tokens`), `auth` (`@/auth`), `workerBuildSha` (`lib/runner/worker-sha`), `runnerInstances` table.
- Produces: bundle bytes with `content-type: application/javascript`, headers `X-Bundle-Sha256`, `X-Worker-Sha`; 401 unauthorized, 503 missing bundle.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/worker-bundle-route.test.ts` (mirrors `environments-build-route.test.ts` conventions: direct handler import, `vi.mock("../auth")`, real DB):

```ts
// __tests__/worker-bundle-route.test.ts
//
// The bundle route is what a blank-provisioned box curls at launch. Auth is
// the run-scoped channel HMAC (or an operator API token / session); the
// sha256 header is what the box verifies after download.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { mintChannelCredential, newChannelInstanceId } from "../lib/worker-channel/credential";

vi.mock("../auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("../lib/api-tokens", () => ({
  verifyToken: vi.fn(async (t: string) => (t === "valid-api-token" ? { id: 1, userId: 1 } : null)),
}));

import { GET } from "../app/api/worker-bundle/route";

let dir: string;
const SECRET_KEY = "TASK_ORCH_WORKER_CHANNEL_SECRET";
let savedSecret: string | undefined;
let savedBundlePath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-route-"));
  savedSecret = process.env[SECRET_KEY];
  process.env[SECRET_KEY] = "test-channel-secret";
  savedBundlePath = process.env.TASK_ORCH_BUNDLE_PATH;
  process.env.TASK_ORCH_WORKER_SHA = "a".repeat(40);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSecret == null) delete process.env[SECRET_KEY];
  else process.env[SECRET_KEY] = savedSecret;
  if (savedBundlePath == null) delete process.env.TASK_ORCH_BUNDLE_PATH;
  else process.env.TASK_ORCH_BUNDLE_PATH = savedBundlePath;
  delete process.env.TASK_ORCH_WORKER_SHA;
  vi.clearAllMocks();
});

function writeBundle(content: string): string {
  const p = join(dir, "run-worker.standalone.js");
  writeFileSync(p, content);
  process.env.TASK_ORCH_BUNDLE_PATH = p;
  return p;
}

async function seededRun(): Promise<{ runId: number; instanceId: string; credential: string }> {
  const run = await create({ goal: "<implement>", defer: true });
  const instanceId = newChannelInstanceId();
  await db.insert(runnerInstances).values({
    runId: run.id,
    provider: "box",
    state: "starting",
    repoPath: "/home/user/repository",
    channelInstanceId: instanceId,
    credentialsVersion: 1,
  });
  return { runId: run.id, instanceId, credential: mintChannelCredential(run.id, instanceId) };
}

function get(headers: Record<string, string> = {}): Request {
  return new Request("http://test/api/worker-bundle", { headers });
}

describe("GET /api/worker-bundle", () => {
  it("serves the bundle with sha256 and worker-sha headers for a valid channel credential", async () => {
    writeBundle("bundle-bytes");
    const { runId, credential } = await seededRun();
    const res = await GET(get({ authorization: `Bearer ${credential}`, "x-run-id": String(runId) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bundle-sha256")).toBe(
      createHash("sha256").update("bundle-bytes").digest("hex")
    );
    expect(res.headers.get("x-worker-sha")).toBe("a".repeat(40));
    expect(await res.text()).toBe("bundle-bytes");
  });

  it("rejects a credential minted for a different run", async () => {
    writeBundle("bundle-bytes");
    const a = await seededRun();
    const b = await seededRun();
    const res = await GET(get({ authorization: `Bearer ${a.credential}`, "x-run-id": String(b.runId) }));
    expect(res.status).toBe(401);
  });

  it("rejects when the run has no runner instance", async () => {
    writeBundle("bundle-bytes");
    const run = await create({ goal: "<implement>", defer: true });
    const cred = mintChannelCredential(run.id, newChannelInstanceId());
    const res = await GET(get({ authorization: `Bearer ${cred}`, "x-run-id": String(run.id) }));
    expect(res.status).toBe(401);
  });

  it("accepts an operator API token without a run id", async () => {
    writeBundle("bundle-bytes");
    const res = await GET(get({ authorization: "Bearer valid-api-token" }));
    expect(res.status).toBe(200);
  });

  it("returns 503 naming the build command when the bundle is missing", async () => {
    process.env.TASK_ORCH_BUNDLE_PATH = join(dir, "missing.js");
    const res = await GET(get({ authorization: "Bearer valid-api-token" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("build:worker:standalone");
  });

  it("rejects with no auth at all", async () => {
    writeBundle("bundle-bytes");
    const res = await GET(get());
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/worker-bundle-route.test.ts`
Expected: FAIL — cannot find module `../app/api/worker-bundle/route`.

- [ ] **Step 3: Implement**

Note the test uses `TASK_ORCH_BUNDLE_PATH` to point the route at a fixture file — add that override to the route (NOT to Task 1's config; it is a route-serving concern):

Create `app/api/worker-bundle/route.ts`:

```ts
// GET /api/worker-bundle — the standalone worker bundle this control plane
// was deployed with (dist/run-worker.standalone.js). A blank-provisioned Box
// curls this at launch, authenticated with its run-scoped channel credential;
// operators/API tokens can fetch it for debugging. The X-Bundle-Sha256 header
// is verified box-side after download.
// Spec: docs/superpowers/specs/2026-07-18-box-blank-provision-design.md §1.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { runnerInstances } from "@/db/schema";
import { verifyToken } from "@/lib/api-tokens";
import { locateWorkerBundle } from "@/lib/worker-bundle";
import { verifyChannelCredential } from "@/lib/worker-channel/credential";
import { workerBuildSha } from "@/lib/runner/worker-sha";

async function authorized(req: Request): Promise<boolean> {
  const bearer = req.headers.get("authorization");
  const token = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : null;

  // Run-scoped channel credential: the box presents the HMAC it was forked
  // with; we verify against the instance id recorded for that run.
  const runIdRaw = req.headers.get("x-run-id");
  if (token && runIdRaw) {
    const runId = Number.parseInt(runIdRaw, 10);
    if (Number.isInteger(runId) && runId > 0) {
      const [row] = await db
        .select({ channelInstanceId: runnerInstances.channelInstanceId })
        .from(runnerInstances)
        .where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.provider, "box")));
      if (row?.channelInstanceId) {
        const verdict = verifyChannelCredential(token, runId, row.channelInstanceId);
        if (verdict.ok) return true;
      }
    }
    // fall through: a bad run-scoped attempt may still be a valid API token
  }

  if (token && (await verifyToken(token)) != null) return true;
  return (await auth()) != null;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const bundle = locateWorkerBundle(
    process.env.TASK_ORCH_BUNDLE_PATH ? { path: process.env.TASK_ORCH_BUNDLE_PATH } : {}
  );
  if (!bundle) {
    return NextResponse.json(
      { error: "Worker bundle not found on this deployment. Build it with `npm run build:worker:standalone`." },
      { status: 503 }
    );
  }

  const sha = await workerBuildSha().catch(() => "unknown");
  return new NextResponse(readFileSync(bundle.path), {
    status: 200,
    headers: {
      "content-type": "application/javascript",
      "content-length": String(bundle.size),
      "x-bundle-sha256": bundle.sha256,
      "x-worker-sha": sha,
      "cache-control": "no-store",
    },
  }) as NextResponse;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/worker-bundle-route.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add app/api/worker-bundle/route.ts __tests__/worker-bundle-route.test.ts
git commit -m "feat(api): serve the standalone worker bundle to blank-provisioned boxes"
```

---

### Task 3: Inject `TASK_ORCH_BUNDLE_URL` into the Box worker env

**Files:**
- Modify: `lib/runner/box-env.ts` (`buildBoxWorkerEnv`)
- Test: `__tests__/box-env.test.ts` (append)

**Interfaces:**
- Produces: the box env contains `TASK_ORCH_BUNDLE_URL=<config.box.bundleUrl>` when that config resolves; absent otherwise. (Present in both modes — harmless under template mode.)

- [ ] **Step 1: Write the failing test**

Append inside the existing describe block of `__tests__/box-env.test.ts` (reuse `CHANNEL_INSTANCE_ID` and the file's `stubBaseEnv()` helper like its neighbors; save/restore `TASK_ORCH_BUNDLE_URL` in the file's env bookkeeping):

```ts
  it("passes the worker-bundle download URL when configured", () => {
    process.env.TASK_ORCH_BUNDLE_URL = "https://tasks.example.com/api/worker-bundle";
    const env = buildBoxWorkerEnv({ runId: 42, repoId: "repo_123", channelInstanceId: CHANNEL_INSTANCE_ID });
    expect(env.TASK_ORCH_BUNDLE_URL).toBe("https://tasks.example.com/api/worker-bundle");
    delete process.env.TASK_ORCH_BUNDLE_URL;
    const bare = buildBoxWorkerEnv({ runId: 42, repoId: "repo_123", channelInstanceId: CHANNEL_INSTANCE_ID });
    expect(bare.TASK_ORCH_BUNDLE_URL).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/box-env.test.ts`
Expected: FAIL — `expected undefined to be 'https://tasks.example.com/api/worker-bundle'`.

- [ ] **Step 3: Implement**

In `buildBoxWorkerEnv` (lib/runner/box-env.ts), after the `TASK_ORCH_CLAUDE_BINARY` line's env object closes and before the credential loop, add:

```ts
  // Blank provisioning: where this box downloads the worker bundle at launch,
  // authenticated with its channel credential (spec: box-blank-provision §1).
  setIfPresent(env, "TASK_ORCH_BUNDLE_URL", config.box.bundleUrl);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/box-env.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-env.ts __tests__/box-env.test.ts
git commit -m "feat(box): hand workers the bundle download URL"
```

---

### Task 4: Extract the detached-step runner into `lib/runner/box-detached.ts`

**Files:**
- Create: `lib/runner/box-detached.ts`
- Modify: `lib/runner/box-template-builder.ts` (replace its inner `run` closure with the shared helper)
- Test: `__tests__/box-detached.test.ts` (create); `__tests__/box-template-builder.test.ts` must stay green unchanged

**Interfaces:**
- Produces: `runDetachedBoxStep(client: BoxClient, boxId: string, label: string, command: string, opts: { timeoutSeconds: number; pollMs: number; callTimeoutSeconds?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<void>` — launches `command` detached (setsid + `.rc`/`.log` marker files under `/tmp/tmpl-step-<label>`), polls until exit, throws `"<label> failed (exit N): <log tail>"` / `"<label> timed out after Ns: <log tail>"` / `"<label> failed to launch: ..."` with the same message shapes the template builder produces today.

- [ ] **Step 1: Write the failing test**

Create `__tests__/box-detached.test.ts`:

```ts
// __tests__/box-detached.test.ts
import { describe, expect, it, vi } from "vitest";
import type { BoxClient, BoxCommandResult } from "../lib/runner/box-client";
import { runDetachedBoxStep } from "../lib/runner/box-detached";

const ok: BoxCommandResult = { success: true, timedOut: false, exitCode: 0, stdout: "", stderr: "" };

function fakeClient(opts: { rc?: string; failLaunch?: boolean } = {}) {
  const commands: string[] = [];
  const client = {
    command: vi.fn(async (_id: string, input: { command: string }) => {
      commands.push(input.command);
      if (input.command.includes("setsid")) {
        if (opts.failLaunch) return { ...ok, exitCode: 1, stderr: "boom" };
        return { ...ok, stdout: "launched" };
      }
      if (input.command.includes(".rc")) return { ...ok, stdout: opts.rc ?? "0" };
      if (input.command.includes("tail -c")) return { ...ok, stdout: "some log tail" };
      return ok;
    }),
  } as unknown as BoxClient;
  return { client, commands };
}

const fast = { timeoutSeconds: 5, pollMs: 1, sleep: async () => {} };

describe("runDetachedBoxStep", () => {
  it("launches detached and resolves when the rc marker reads 0", async () => {
    const { client, commands } = fakeClient();
    await runDetachedBoxStep(client, "bx_1", "provisioning", "echo hi", fast);
    expect(commands[0]).toContain("setsid");
    expect(commands[0]).toContain("echo hi");
  });

  it("throws with the log tail when the step exits non-zero", async () => {
    const { client } = fakeClient({ rc: "1" });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "false", fast)
    ).rejects.toThrow(/provisioning failed \(exit 1\): some log tail/);
  });

  it("throws when the launch itself fails", async () => {
    const { client } = fakeClient({ failLaunch: true });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "true", fast)
    ).rejects.toThrow(/provisioning failed to launch/);
  });

  it("times out against the injected clock", async () => {
    let t = 0;
    const { client } = fakeClient({ rc: "__running__" });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "sleep 999", {
        ...fast,
        now: () => (t += 4_000),
      })
    ).rejects.toThrow(/provisioning timed out/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/box-detached.test.ts`
Expected: FAIL — cannot find module `../lib/runner/box-detached`.

- [ ] **Step 3: Implement**

Create `lib/runner/box-detached.ts` by MOVING the body of the `run` closure from `lib/runner/box-template-builder.ts` (lines ~77–123: the `base`/`inner`/`launch` construction, `readTail`, and the poll loop) into:

```ts
// lib/runner/box-detached.ts
//
// Detached long-step execution on a Box. Each Box `command` call has a
// platform-enforced max duration well under a long npm ci or git clone, so a
// step is LAUNCHED detached (setsid, output + exit code redirected to marker
// files) via one short call, then POLLED with short calls until it finishes
// or the budget elapses. Extracted from box-template-builder so blank
// provisioning (box.ts) shares the proven pattern.
import type { BoxClient } from "./box-client";

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runDetachedBoxStep(
  client: BoxClient,
  boxId: string,
  label: string,
  command: string,
  opts: {
    timeoutSeconds: number;
    pollMs: number;
    callTimeoutSeconds?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const callTimeout = opts.callTimeoutSeconds ?? 60;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const base = `/tmp/tmpl-step-${label}`;
  const inner = `(${command}) > ${base}.log 2>&1; echo $? > ${base}.rc`;
  const launch = `rm -f ${base}.rc ${base}.log; setsid sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & echo launched`;
  const started = await client.command(boxId, { command: launch, cwd: ".", timeoutSeconds: callTimeout });
  if (!started.success || started.timedOut || started.exitCode !== 0) {
    const detail = (started.stderr || started.stdout || "").slice(-500);
    throw new Error(`${label} failed to launch: ${detail}`);
  }

  const readTail = async (): Promise<string> => {
    try {
      const t = await client.command(boxId, {
        command: `tail -c 2000 ${base}.log 2>/dev/null || true`,
        cwd: ".",
        timeoutSeconds: callTimeout,
      });
      return (t.stdout ?? "").slice(-2_000);
    } catch {
      return "(log unavailable)";
    }
  };

  const deadline = now() + opts.timeoutSeconds * 1000;
  for (;;) {
    await sleep(opts.pollMs);
    if (now() > deadline) {
      throw new Error(`${label} timed out after ${opts.timeoutSeconds}s: ${await readTail()}`);
    }
    const probe = await client.command(boxId, {
      command: `if [ -f ${base}.rc ]; then cat ${base}.rc; else echo __running__; fi`,
      cwd: ".",
      timeoutSeconds: callTimeout,
    });
    if (!probe.success || probe.timedOut) continue;
    const out = (probe.stdout ?? "").trim();
    if (out === "" || out === "__running__") continue;
    const rc = Number.parseInt(out, 10);
    if (Number.isNaN(rc)) continue;
    if (rc === 0) return;
    throw new Error(`${label} failed (exit ${rc}): ${await readTail()}`);
  }
}
```

In `lib/runner/box-template-builder.ts`, replace the inner `run` closure with a thin wrapper that preserves the builder's error-message prefix (existing tests assert on "Template build step <label>"):

```ts
  const run = async (boxIdNow: string, label: string, command: string): Promise<void> => {
    try {
      await runDetachedBoxStep(this ? undefined as never : client, boxIdNow, label, command, {} as never);
    } catch {
      /* replaced below */
    }
  };
```

— NO. Do it directly (the above is what NOT to write). The real replacement:

```ts
  const run = async (boxIdNow: string, label: string, command: string): Promise<void> => {
    try {
      await runDetachedBoxStep(client, boxIdNow, label, command, {
        timeoutSeconds: config.box.buildStepTimeoutSeconds,
        pollMs: config.box.pollMs,
        callTimeoutSeconds: CALL_TIMEOUT_S,
        now,
        sleep,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Template build step ${msg}`);
    }
  };
```

(The helper's messages start with `<label> …`, so prefixing `Template build step ` reproduces the exact legacy strings: "Template build step installing-deps failed (exit 1): …". Delete the now-dead `shq` usage only if unused — `shq` is still used by the step commands, keep it.) Add the import `import { runDetachedBoxStep } from "./box-detached";` and delete the moved code.

- [ ] **Step 4: Run to verify pass — including the untouched builder suite**

Run: `npx vitest run __tests__/box-detached.test.ts __tests__/box-template-builder.test.ts`
Expected: all pass, builder tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box-detached.ts lib/runner/box-template-builder.ts __tests__/box-detached.test.ts
git commit -m "refactor(box): extract detached step runner for reuse by blank provisioning"
```

---

### Task 5: Blank provisioning in `BoxRunnerProvider`

**Files:**
- Modify: `lib/runner/box.ts` (`admit()` template block, `create()`)
- Test: `__tests__/box-blank-provision.test.ts` (create); `__tests__/box-admission.test.ts` (append one test)

**Interfaces:**
- Consumes: `config.box.provisionMode` / `bundleUrl` / `provisionTimeoutSeconds` (Task 1), `runDetachedBoxStep` (Task 4), `workerBuildSha` (`./worker-sha`), `ownerRepoFromRemote` (`../gh-url`), `dbTransport.resolveRepo`, `BOX_TEMPLATE_MANIFEST_PATH`/`BOX_TEMPLATE_WORKER_PROTOCOL_VERSION` (`./box-template`).
- Produces: in blank mode, `create()` provisions via `client.create` + provision command and then calls the existing `readyAndLaunch` unchanged; `admit()` never defers on template state. `runnerInstances.boxTemplateId` stays null for blank boxes.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/box-blank-provision.test.ts` (mirror `__tests__/box-provider-e2e.test.ts`'s fake-client/DB setup — read that file first and reuse its helpers/fixture style, including a repository row with a GitHub `remote`):

```ts
// __tests__/box-blank-provision.test.ts
//
// Blank provisioning: no template snapshot. create() must CREATE a blank box
// (never fork), run one detached provision command that downloads the bundle
// (curl + sha256 verify against the X-Bundle-Sha256 header), clones the RUN'S
// OWN repo, writes the standard manifest — and then the normal manifest/
// bootstrap flow proceeds unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// ... imports mirroring box-provider-e2e.test.ts (db, schema, BoxRunnerProvider, fake client)

// Env: TASK_ORCH_BOX_PROVISION unset (blank is the default),
// TASK_ORCH_BUNDLE_URL=https://cp.example.com/api/worker-bundle,
// TASK_ORCH_WORKER_SHA=<40 chars> so workerBuildSha() is deterministic.

describe("box blank provisioning", () => {
  it("creates a blank box (no fork) and provisions bundle + repo clone + manifest", async () => {
    // Arrange a run with a repository whose remote is git@github.com:acme/widget.git.
    // Fake client: create() returns a ready box; command() records commands and
    // answers the detached-step protocol (setsid → launched, .rc → 0, cat manifest
    // → a valid manifest JSON matching what the provision command writes).
    // Act: provider.create({ runId, scope, channelInstanceId }).
    // Assert:
    //   - client.create called with { env, noEnv: true }; client.fork NEVER called;
    //   - env passed to create() contains TASK_ORCH_BUNDLE_URL and the channel credential;
    //   - some launched command contains `curl` AND `$TASK_ORCH_BUNDLE_URL` AND `x-bundle-sha256`;
    //   - some launched command contains `git clone --depth 1` AND `github.com/acme/widget`;
    //   - some launched command writes template.json containing `"workerEntryPath":"/home/user/worker/run-worker.js"`
    //     and `"repository":"acme/widget"`;
    //   - no command text contains the literal GH_TOKEN value (only the `$GH_TOKEN` env reference);
    //   - runnerInstances row: provider box, boxTemplateId null, state running after launch.
  });

  it("fails actionably when no bundle URL is configured", async () => {
    // TASK_ORCH_BUNDLE_URL and AUTH_URL both unset → create() rejects with an
    // error naming TASK_ORCH_BUNDLE_URL before any box API call.
  });

  it("surfaces the provision log tail when the provision step fails", async () => {
    // Fake client answers .rc probe with "1" and tail with "clone failed: repo not found".
    // create() must reject with /provision/ and /clone failed/.
  });
});
```

Write these three tests OUT IN FULL by mirroring the concrete setup in `__tests__/box-provider-e2e.test.ts` (its fake client, run/repository seeding, env bookkeeping). The comments above are the required assertions, not placeholders to skip.

Append to `__tests__/box-admission.test.ts`:

```ts
  it("blank mode: admits without any template state (no defer on missing template)", async () => {
    // With TASK_ORCH_BOX_PROVISION unset (default blank) and NO environments row
    // seeded, admit() for a run whose repo has a GitHub remote must return
    // { decision: "admit" } (given fake limits with capacity) — never a
    // "Building box template…" defer.
  });
```

(Again: write it fully, mirroring the file's existing seeding helpers.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/box-blank-provision.test.ts __tests__/box-admission.test.ts`
Expected: new tests FAIL — `create()` forks a template / `admit()` defers on template build.

- [ ] **Step 3: Implement in `lib/runner/box.ts`**

Imports to add:

```ts
import { runDetachedBoxStep } from "./box-detached";
import { workerBuildSha } from "./worker-sha";
```

(`ownerRepoFromRemote`, `dbTransport`, `BOX_TEMPLATE_MANIFEST_PATH` are already imported.)

In `admit()`, wrap the template-resolution block (the `const template = await resolveBoxTemplate(...)` through the cooldown `return`) so it only runs in template mode:

```ts
      if (config.box.provisionMode === "template") {
        const template = await resolveBoxTemplate({ runId: input.runId });
        // ... existing building/cooldown defers unchanged ...
      }
      return boxAdmissionDecision(await this.box().limits(), input);
```

In `create()`, after the admission check (line ~309), branch:

```ts
    if (config.box.provisionMode === "blank") {
      return this.createBlank(input, run.repoId, channelInstanceId);
    }
    // template mode: existing resolveBoxTemplate + fork flow, unchanged
```

Add the new private method (next to `readyAndLaunch`):

```ts
  /** Blank provisioning (spec: box-blank-provision): create a blank box, run
   *  ONE detached provision command (bundle download + repo clone + manifest),
   *  then reuse the normal manifest/bootstrap flow. No template snapshot. */
  private async createBlank(
    input: CreateRunnerInput,
    repoId: string,
    channelInstanceId: string,
  ): Promise<RunnerRef | null> {
    const box = this.box();
    if (!config.box.bundleUrl) {
      throw new Error(
        "Blank box provisioning needs a worker-bundle URL: set TASK_ORCH_BUNDLE_URL " +
          "(or AUTH_URL), or set TASK_ORCH_BOX_PROVISION=template."
      );
    }
    const repoRow = await dbTransport.resolveRepo(input.runId);
    const ownerRepo = repoRow ? ownerRepoFromRemote(repoRow.remote ?? null) : null;
    if (!ownerRepo) {
      throw new Error(`Run ${input.runId}: repository has no usable GitHub remote to clone.`);
    }
    const repoPath = config.box.repoPath ?? "/home/user/repository";
    const sha = await workerBuildSha();

    const env = buildBoxWorkerEnv({
      runId: input.runId,
      repoId,
      channelInstanceId,
      templateVersion: sha,
      repoPath,
    });

    let boxId: string | undefined;
    try {
      await emitBoxEvent(input.runId, "runner_box_provisioning", { mode: "blank", workerSha: sha });
      const created = await box.create({ env, noEnv: true });
      boxId = created.id;

      await db
        .insert(runnerInstances)
        .values({
          runId: input.runId,
          provider: "box",
          boxId,
          state: "starting",
          repoPath,
          lastStartedAt: new Date(),
          credentialsVersion: 1,
          lastProviderError: null,
          channelInstanceId,
        })
        .onConflictDoUpdate({
          target: runnerInstances.runId,
          set: {
            provider: "box",
            boxId,
            boxTemplateId: null,
            state: "starting",
            lastStartedAt: new Date(),
            credentialsVersion: 1,
            lastProviderError: null,
            channelInstanceId,
          },
        });

      await box.update(boxId, { name: boxName(input) });
      await waitForBoxReady(box, boxId, {
        timeoutMs: config.box.readyTimeoutMs,
        pollMs: config.box.pollMs,
      });
      await runDetachedBoxStep(box, boxId, "provisioning", blankProvisionCommand(ownerRepo, repoPath, sha), {
        timeoutSeconds: config.box.provisionTimeoutSeconds,
        pollMs: config.box.pollMs,
      });
      return await this.readyAndLaunch(input, boxId, channelInstanceId);
    } catch (error) {
      const normalized = await normalizeBoxApiError(error);
      if (boxId) {
        await this.recordFailure(input.runId, boxId, normalized);
        await box.stop(boxId).catch(() => {});
      }
      throw error;
    }
  }
```

Add the module-level command builder (near `WORKER_BOOTSTRAP_COMMAND`). Secrets stay in the box's env — only `ownerRepo`, `repoPath`, and the manifest JSON are interpolated server-side:

```ts
/** The blank-box provision script. Env-expanded ON THE BOX ($TASK_ORCH_…,
 *  $GH_TOKEN); the control plane interpolates only repo identity and paths. */
function blankProvisionCommand(ownerRepo: string, repoPath: string, workerSha: string): string {
  const manifest = JSON.stringify({
    formatVersion: 1,
    workerBuildSha: workerSha,
    workerProtocolVersion: BOX_TEMPLATE_WORKER_PROTOCOL_VERSION,
    repository: ownerRepo,
    repositoryPath: repoPath,
    workerEntryPath: "/home/user/worker/run-worker.js",
  });
  const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  return [
    `set -eu`,
    `command -v git >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || { echo "blank box missing git/node/curl" >&2; exit 127; }`,
    `mkdir -p /home/user/worker /home/user/.task-orchestrator`,
    `curl -fsS --retry 3 --retry-delay 2 -H "authorization: Bearer $TASK_ORCH_WORKER_CHANNEL_CREDENTIAL" -H "x-run-id: $TASK_ORCH_RUN_ID" -D /tmp/worker-bundle.headers -o /home/user/worker/run-worker.js "$TASK_ORCH_BUNDLE_URL"`,
    `want=$(tr -d '\\r' < /tmp/worker-bundle.headers | awk 'tolower($1)=="x-bundle-sha256:" {print $2}')`,
    `got=$(sha256sum /home/user/worker/run-worker.js | awk '{print $1}')`,
    `[ -n "$want" ] && [ "$want" = "$got" ] || { echo "bundle checksum mismatch (want=$want got=$got)" >&2; exit 1; }`,
    `test ! -e ${shq(repoPath)}`,
    `if [ -n "\${GH_TOKEN:-}" ]; then git clone --depth 1 "https://x-access-token:\${GH_TOKEN}@github.com/${ownerRepo}.git" ${shq(repoPath)}; else git clone --depth 1 "https://github.com/${ownerRepo}.git" ${shq(repoPath)}; fi`,
    `printf '%s\\n' ${shq(manifest)} > ${shq(BOX_TEMPLATE_MANIFEST_PATH)}`,
  ].join("; ");
}
```

Also add `"blank"`-mode manifest tolerance in `readyAndLaunch`: nothing to change — the provision command writes the same manifest shape the parser already accepts.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/box-blank-provision.test.ts __tests__/box-admission.test.ts __tests__/box-provider-e2e.test.ts __tests__/box-template-provider.test.ts`
Note: the two template-flow test files exercise template mode — set `TASK_ORCH_BOX_PROVISION=template` in their env setup if they fail under the new default, and add that env var to their save/restore bookkeeping.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/box.ts __tests__/box-blank-provision.test.ts __tests__/box-admission.test.ts __tests__/box-provider-e2e.test.ts __tests__/box-template-provider.test.ts
git commit -m "feat(box): blank provisioning — download worker + clone repo at launch, no template snapshot"
```

---

### Task 6: Server image builds the bundle; docs

**Files:**
- Modify: `Dockerfile.server` (build stage + runtime COPY)
- Modify: `docs/superpowers/specs/2026-07-18-box-blank-provision-design.md` (status note), `docs/agent-caveats.md` (one bullet under the Box section)

- [ ] **Step 1: Dockerfile**

In `Dockerfile.server`'s build stage, after `RUN npm run build` (line ~19), add:

```dockerfile
# The standalone worker bundle served by GET /api/worker-bundle to
# blank-provisioned Box runners. Version-locked to this image by construction.
RUN npm run build:worker:standalone
```

In the runtime stage, next to the other `COPY --from=build` lines, add:

```dockerfile
COPY --from=build /app/dist ./dist
```

Verify: `docker build -f Dockerfile.server .` if Docker is available locally; otherwise `grep`-verify both lines landed and rely on the route's 503 guard + deploy smoke.

- [ ] **Step 2: Docs**

Append to the spec's Design §1 a one-line status: route + blank provisioning landed (commit range), template mode kept behind `TASK_ORCH_BOX_PROVISION=template`. In `docs/agent-caveats.md`'s Box section add one bullet: blank provisioning is the default — a box run needs no template; `TASK_ORCH_BUNDLE_URL` (or `AUTH_URL`) must resolve on the control plane, and the served bundle comes from `dist/run-worker.standalone.js` in the server deployment.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.server docs/superpowers/specs/2026-07-18-box-blank-provision-design.md docs/agent-caveats.md
git commit -m "feat(server): ship the worker bundle in the server image; blank-provision docs"
```

---

### Task 7: Full verification

- [ ] **Step 1:** `npx vitest run` — green except the two known flakes (Global Constraints).
- [ ] **Step 2:** `npx tsc --noEmit` — exit 0.
- [ ] **Step 3 (manual, after push + deploy):** dispatch a Box run and confirm from its events: `runner_box_provisioning` → `runner_box_ready` → completed turn, with no `runner_box_template_*` events; record wall-clock from dispatch to worker heartbeat.

## Out of scope (tracked in the spec)

- Deleting template/environments machinery, `/environments` page, CI warm job.
- Bundle/repo caching across runs.
- Fly/Docker fetch-at-launch.
