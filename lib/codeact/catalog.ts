import { discoverOperations, operationCatalog } from "../app-api";
import { hasAppApiCapability } from "../app-api/dispatcher";
import type { AppApiContext } from "../app-api/types";

export interface CatalogLimits { maxEntries?: number; maxBytes?: number }
export interface CatalogFilter { query?: string; names?: readonly string[] }

function boundedCatalog(entries: ReturnType<typeof operationCatalog>, limits: CatalogLimits, filter: CatalogFilter) {
  // Search the entire authorized registry before imposing response limits.
  const names = filter.names ? new Set(filter.names) : undefined;
  entries = entries.filter((entry) => names
    ? [entry.name, entry.sdkPath, ...entry.aliases].some((name) => names.has(name))
    : !filter.query || JSON.stringify(entry).toLowerCase().includes(filter.query.toLowerCase()));
  const maxEntries = Math.max(1, Math.min(limits.maxEntries ?? 100, 100));
  const maxBytes = Math.max(1024, Math.min(limits.maxBytes ?? 256 * 1024, 1024 * 1024));
  const result: typeof entries = [];
  let bytes = 2;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (result.length >= maxEntries || bytes + size + 1 > maxBytes) break;
    result.push(entry);
    bytes += size + 1;
  }
  return { version: "v1" as const, operations: result, truncated: result.length < entries.length };
}

/** Return only the caller's authorized, bounded operation catalogue. */
export function codeActCatalog(
  allowedTools?: ReadonlySet<string> | readonly string[],
  limits: CatalogLimits = {},
  filter: CatalogFilter = {},
) {
  const allowed = allowedTools ? new Set(allowedTools) : undefined;
  const entries = operationCatalog().filter((entry) => !allowed || allowed.has(entry.name) || entry.aliases.some((a) => allowed.has(a)));
  return boundedCatalog(entries, limits, filter);
}

/** Build discovery from the same runtime/capability decision the dispatcher
 * applies. This is an ergonomic filter only: every actual subcall is checked
 * again at dispatch time. */
export function codeActCatalogForContext(
  context: AppApiContext,
  limits: CatalogLimits = {},
  filter: CatalogFilter = {},
) {
  const entries = operationCatalog().filter((entry) => {
    const descriptor = discoverOperations().find((candidate) => candidate.name === entry.name);
    return Boolean(
      descriptor &&
      hasAppApiCapability(context, descriptor) &&
      (context.runtime !== "server" || descriptor.serverSafe),
    );
  });
  return boundedCatalog(entries, limits, filter);
}

export function describeCodeActCatalog(names: readonly string[], allowedTools?: ReadonlySet<string> | readonly string[]) {
  return codeActCatalog(allowedTools, {}, { names });
}

/** Kept as a side-effect-free import for callers that need descriptor count. */
export function codeActOperationCount(): number { return discoverOperations().length; }
