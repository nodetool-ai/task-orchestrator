// Validation for the immutable metadata baked into a Box runner template.
//
// This module deliberately has no Box SDK dependency: callers obtain the text
// through whichever transport is appropriate, then validate it before they
// launch a worker from that filesystem snapshot.

import path from "node:path";

export const BOX_TEMPLATE_MANIFEST_PATH = "/home/user/.task-orchestrator/template.json";
export const BOX_TEMPLATE_WORKER_PROTOCOL_VERSION = 1;

export type BoxTemplateManifest = {
  formatVersion: number;
  workerBuildSha: string;
  workerProtocolVersion: number;
  repository: string;
  repositoryPath: string;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Box template manifest: '${field}' must be a non-empty string.`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Box template manifest: '${field}' must be a positive integer.`);
  }
  return value;
}

/**
 * Parse the template manifest. Unknown keys remain intentionally tolerated so
 * an upgraded publisher can add metadata without breaking an older runner.
 */
export function parseBoxTemplateManifest(
  text: string,
  opts: { workerProtocolVersion?: number } = {}
): BoxTemplateManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Box template manifest is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Box template manifest must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const manifest: BoxTemplateManifest = {
    // The publication design predated this field. Treat its absence as v1 so
    // the first template can be validated without a metadata-only rebuild.
    formatVersion: record.formatVersion == null ? 1 : requiredPositiveInteger(record.formatVersion, "formatVersion"),
    workerBuildSha: requiredString(record.workerBuildSha, "workerBuildSha"),
    workerProtocolVersion: requiredPositiveInteger(record.workerProtocolVersion, "workerProtocolVersion"),
    repository: requiredString(record.repository, "repository"),
    repositoryPath: requiredString(record.repositoryPath, "repositoryPath"),
  };

  if (!/^[^/\s]+\/[^/\s]+$/.test(manifest.repository)) {
    throw new Error("Box template manifest: 'repository' must be in owner/repository form.");
  }
  const normalizedRepositoryPath = path.posix.normalize(manifest.repositoryPath);
  if (
    !path.posix.isAbsolute(manifest.repositoryPath) ||
    !normalizedRepositoryPath.startsWith("/home/user/") ||
    normalizedRepositoryPath !== manifest.repositoryPath
  ) {
    throw new Error("Box template manifest: 'repositoryPath' must be an absolute path under /home/user.");
  }
  const expected = opts.workerProtocolVersion ?? BOX_TEMPLATE_WORKER_PROTOCOL_VERSION;
  if (manifest.workerProtocolVersion !== expected) {
    throw new Error(
      `Box template worker protocol ${manifest.workerProtocolVersion} is incompatible with required version ${expected}.`
    );
  }
  return manifest;
}
