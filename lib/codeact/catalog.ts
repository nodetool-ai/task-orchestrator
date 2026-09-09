import { discoverOperations, operationCatalog } from "../app-api";
import { hasAppApiCapability } from "../app-api/dispatcher";
import type { AppApiContext } from "../app-api/types";

export interface CatalogLimits { maxEntries?: number; maxBytes?: number }

/** Return only the caller's authorized, bounded operation catalogue. */
export function codeActCatalog(
  allowedTools?: ReadonlySet<string> | readonly string[],
  limits: CatalogLimits = {},
) {
  const allowed = allowedTools ? new Set(allowedTools) : undefined;
  const entries = operationCatalog().filter((entry) => !allowed || allowed.has(entry.name) || entry.aliases.some((a) => allowed.has(a)));
  const maxEntries = Math.max(1, Math.min(limits.maxEntries ?? 100, 100));
  const maxBytes = Math.max(1024, Math.min(limits.maxBytes ?? 256 * 1024, 1024 * 1024));
  const result: typeof entries = [];
  let bytes = 2;
  for (const entry of entries) {
    const next = JSON.stringify(entry);
    if (result.length >= maxEntries || bytes + next.length + 1 > maxBytes) break;
    result.push(entry); bytes += next.length + 1;
  }
  return { version: "v1" as const, operations: result, truncated: result.length < entries.length };
}

/** Build discovery from the same runtime/capability decision the dispatcher
 * applies. This is an ergonomic filter only: every actual subcall is checked
 * again at dispatch time. */
export function codeActCatalogForContext(
  context: AppApiContext,
  limits: CatalogLimits = {},
) {
  const entries = operationCatalog().filter((entry) => {
    const descriptor = discoverOperations().find((candidate) => candidate.name === entry.name);
    return Boolean(
      descriptor &&
      hasAppApiCapability(context, descriptor) &&
      (context.runtime !== "server" || descriptor.serverSafe),
    );
  });
  const maxEntries = Math.max(1, Math.min(limits.maxEntries ?? 100, 100));
  const maxBytes = Math.max(1024, Math.min(limits.maxBytes ?? 256 * 1024, 1024 * 1024));
  const result: typeof entries = [];
  let bytes = 2;
  for (const entry of entries) {
    const next = JSON.stringify(entry);
    if (result.length >= maxEntries || bytes + next.length + 1 > maxBytes) break;
    result.push(entry);
    bytes += next.length + 1;
  }
  return { version: "v1" as const, operations: result, truncated: result.length < entries.length };
}

export function describeCodeActCatalog(names: readonly string[], allowedTools?: ReadonlySet<string> | readonly string[]) {
  const catalog = codeActCatalog(allowedTools, { maxEntries: 100 });
  return { ...catalog, operations: catalog.operations.filter((x) => names.includes(x.name) || names.includes(x.sdkPath) || x.aliases.some((a) => names.includes(a))) };
}

/** Kept as a side-effect-free import for callers that need descriptor count. */
export function codeActOperationCount(): number { return discoverOperations().length; }
