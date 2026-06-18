// Edge-safe auth-mode helper. Reads only process.env so it can be imported
// from both the Edge middleware and the Node runtime (auth.ts).
//
// In local development (`next dev`, NODE_ENV=development) the login gate is
// disabled: middleware lets every request through and auth() returns a
// synthetic session for the local dev user (see DEV_USER_EMAIL).
//
// Production (`next start`, NODE_ENV=production) and tests (vitest, "test")
// keep auth enforced. We key off NODE_ENV rather than the request host
// because production runs on localhost:3000 behind a Cloudflare tunnel — a
// host check would also open up prod.

export const DEV_USER_EMAIL = "local@localhost";

export function isAuthDisabled(): boolean {
  return process.env.NODE_ENV === "development";
}
