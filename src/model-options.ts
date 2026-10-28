import type {
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";

/**
 * Model picker shaping.
 *
 * Letta's catalog lists every reasoning tier as its own entry, and large-context
 * variants as further entries sharing the same handle — so the raw list is a wall
 * of near-identical rows. Two transforms fix that: collapse each model variant to
 * one row (the tier is chosen through the thought-level option instead), and group
 * rows by provider so the origin of a model is visible.
 *
 * Provider names come from the handle namespace, since the SDK's catalog entry
 * exposes only { id, handle, label, description, isDefault, isFeatured, free,
 * updateArgs } — no brand field.
 */

/** Context window an entry targets; separates 1M-style variants of one handle. */
function contextWindowOf(entry: LettaCodeModelEntry): number | undefined {
  const value = entry.updateArgs?.context_window;
  return typeof value === "number" ? value : undefined;
}

function reasoningEffortOf(entry: LettaCodeModelEntry): string | undefined {
  const value = entry.updateArgs?.reasoning_effort;
  return typeof value === "string" ? value : undefined;
}

const variantKey = (entry: LettaCodeModelEntry): string =>
  `${entry.handle}@${contextWindowOf(entry) ?? ""}`;

/**
 * The entry that best represents a variant: the catalog's featured pick, else the
 * untiered default, else "high", else whatever comes first.
 */
function representative(members: LettaCodeModelEntry[]): LettaCodeModelEntry {
  return (
    members.find((entry) => entry.isFeatured === true) ??
    members.find((entry) => reasoningEffortOf(entry) === undefined) ??
    members.find((entry) => reasoningEffortOf(entry) === "high") ??
    members[0]
  );
}

/** One entry per model variant (handle + context window), catalog order. */
export function collapseVariants(
  entries: LettaCodeModelEntry[],
): LettaCodeModelEntry[] {
  const groups = new Map<string, LettaCodeModelEntry[]>();
  for (const entry of entries) {
    const key = variantKey(entry);
    const members = groups.get(key);
    if (members) members.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()].map(representative);
}

/** The collapsed variant that contains this entry. */
export function variantOf(
  entry: LettaCodeModelEntry,
  variants: LettaCodeModelEntry[],
): LettaCodeModelEntry | undefined {
  const key = variantKey(entry);
  return variants.find((variant) => variantKey(variant) === key);
}

/** Grouping key for a model: the namespace of its handle. */
function providerKey(entry: LettaCodeModelEntry): string {
  const slash = entry.handle.indexOf("/");
  return slash > 0 ? entry.handle.slice(0, slash) : "other";
}

const PROVIDER_LABELS: Record<string, string> = {
  letta: "Letta",
  openai: "OpenAI",
  "openai-codex": "ChatGPT",
  "chatgpt-plus-pro": "ChatGPT",
  anthropic: "Anthropic",
  google_ai: "Google",
  google_vertex: "Google Vertex",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  moonshotai: "Moonshot",
  zai: "Z.ai",
  "z-ai": "Z.ai",
  minimax: "MiniMax",
  meta: "Meta",
  mistral: "Mistral",
  thinkingmachines: "Thinking Machines",
  bedrock: "Amazon Bedrock",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  umans: "Umans",
  ollama: "Ollama",
};

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function providerLabel(key: string): string {
  if (key === "other") return "Other";
  return PROVIDER_LABELS[key] ?? titleCase(key);
}

/** Namespace of Letta's own built-in models (auto-routing); no provider needed. */
const BUILTIN_NAMESPACE = "letta";

/**
 * Whether a model can actually be served: it comes from a connected provider, or
 * it is one of Letta's built-ins. Providers the user has no keys for are dropped.
 */
export function isUsableModel(
  entry: LettaCodeModelEntry,
  connectedProviders: Set<string>,
): boolean {
  const key = providerKey(entry);
  return key === BUILTIN_NAMESPACE || connectedProviders.has(key);
}

/** Drop runtime provider decorations already supplied by the group heading. */
function withoutProviderSuffix(label: string, providerName: string, providerId: string): string {
  const separator = label.lastIndexOf(" · ");
  const undecorated = separator >= 0 &&
    label.slice(separator + 3).trim().toLowerCase() === providerId.toLowerCase()
    ? label.slice(0, separator).trim()
    : label;
  const stripped = undecorated.replace(
    /\s*\(([^)]*)\)\s*$/,
    (whole: string, inner: string) =>
      inner.trim().toLowerCase() === providerName.trim().toLowerCase()
        ? ""
        : whole,
  );
  return stripped.trim() || label;
}

/** Collapsed variants as ACP select groups — one group per provider. */
export function groupedModelOptions(
  variants: LettaCodeModelEntry[],
): SessionConfigSelectGroup[] {
  const groups = new Map<
    string,
    { name: string; options: SessionConfigSelectOption[] }
  >();
  for (const variant of variants) {
    const key = providerKey(variant);
    let group = groups.get(key);
    if (!group) {
      group = { name: providerLabel(key), options: [] };
      groups.set(key, group);
    }
    group.options.push({
      value: variant.id,
      name: withoutProviderSuffix(variant.label, group.name, key),
      ...(variant.description ? { description: variant.description } : {}),
    });
  }
  return [...groups].map(([key, group]) => ({
    group: key,
    name: group.name,
    options: group.options,
  }));
}
