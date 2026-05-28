import { type NextRequest } from "next/server";
import { parseWebhookEvent, verifySignature } from "@/lib/github-webhook";
import { handleWebhookEvent } from "@/lib/github-webhook-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GitHub webhook receiver. Configure a repo/org webhook pointing at
// <NEXTAUTH_URL>/api/github/webhook with content type application/json and the
// shared secret in GITHUB_WEBHOOK_SECRET. This route is exempt from the auth
// middleware (see middleware.ts) and authenticates instead via the
// X-Hub-Signature-256 HMAC.
//
// Recommended events: Pull requests, Pull request reviews, Issue comments,
// Check runs, Check suites, Workflow runs (and/or Statuses).
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration, not the sender's fault — but don't process unverified.
    return jsonResponse({ error: "Webhook not configured" }, 503);
  }

  const eventName = req.headers.get("x-github-event");
  const signature = req.headers.get("x-hub-signature-256");
  const deliveryId = req.headers.get("x-github-delivery");

  // Read the raw body BEFORE parsing — the HMAC is over the exact bytes.
  const rawBody = await req.text();

  if (!verifySignature(rawBody, signature, secret)) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  if (eventName === "ping") {
    return jsonResponse({ ok: true, pong: true });
  }
  if (!eventName) {
    return jsonResponse({ error: "Missing X-GitHub-Event" }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const event = parseWebhookEvent(eventName, payload);
  if (!event) {
    // Event type we don't act on (or unparseable shape). Acknowledge so GitHub
    // doesn't retry.
    return jsonResponse({ ok: true, ignored: eventName });
  }

  try {
    const result = await handleWebhookEvent(event, deliveryId);
    return jsonResponse({
      ok: true,
      event: eventName,
      kind: event.kind,
      matched: result.matched,
      actions: result.actions,
    });
  } catch (err) {
    // Surface a 500 so GitHub retries; log for diagnosis.
    console.error("github-webhook: dispatch failed:", err);
    return jsonResponse({ error: "Dispatch failed" }, 500);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
