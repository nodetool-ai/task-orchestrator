// Edge-safe route matcher shared by middleware.ts and its test.
//
// The exact API surface the terminal cockpit (`orch`, tui/) reads and writes
// (tui PRD §4 / T-tui-11). Middleware forwards a request on one of these paths
// when it carries an Authorization header, so the route itself can verify the
// bearer token (lib/api-auth). It is an explicit allowlist rather than a
// blanket /api/* rule so attaching a junk header can never reach a route that
// does not verify it.

const COCKPIT_ROUTES: RegExp[] = [
  /^\/api\/(inbox|tasks|plans|personas)$/,
  /^\/api\/runs$/,
  /^\/api\/runs\/overview(\/events)?$/,
  /^\/api\/runs\/\d+(\/(events|messages|inbox))?$/,
];

export function isCockpitRoute(path: string): boolean {
  return COCKPIT_ROUTES.some((re) => re.test(path));
}
