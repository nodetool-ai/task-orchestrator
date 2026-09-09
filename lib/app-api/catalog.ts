import { operationCatalog } from "./registry";

/** JSON-serializable discovery payload for SDK clients. */
export function discoverAppApi() {
  return { version: "v1" as const, operations: operationCatalog() };
}

/** Generated declaration text for lightweight SDK consumers. */
export function generateTypeScriptDeclarations(): string {
  const operations = operationCatalog();
  const lines = ["// Generated from lib/app-api descriptors; do not edit.", "export interface AppApiV1 {"];
  for (const operation of operations) {
    lines.push(`  ${operation.sdkPath.replace(/^app\./, "").replace(/\./g, "_")}: (input: unknown) => Promise<unknown>;`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
