export function parseProviderQualifiedModel(rawModel: string): {
  provider: string;
  id: string;
} {
  // Only the first slash separates provider from model id. Some provider
  // catalogs, notably OpenRouter, use model ids that also contain slashes.
  const slash = rawModel.indexOf("/");
  if (slash < 0) return { provider: "anthropic", id: rawModel };
  return {
    provider: rawModel.slice(0, slash),
    id: rawModel.slice(slash + 1),
  };
}
