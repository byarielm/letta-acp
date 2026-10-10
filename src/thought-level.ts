import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";

/**
 * ACP "thought level" selector.
 *
 * Letta exposes reasoning tiers as separate catalog entries that share a handle
 * and differ only by `updateArgs.reasoning_effort`; the SDK resolves a selected
 * tier back to the matching entry's id. The tier vocabulary is wider than the
 * SDK's `ReasoningEffort` union (which omits "max"), so tiers are carried as
 * strings and validated against the catalog rather than the SDK type.
 */

export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

/** Canonical tier order, low → high. Unknown tiers keep catalog order, after. */
const REASONING_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The reasoning tier a catalog entry encodes, if any. */
export function entryReasoningEffort(
  entry: LettaCodeModelEntry,
): string | undefined {
  const effort = entry.updateArgs?.reasoning_effort;
  return typeof effort === "string" ? effort : undefined;
}

/** Reasoning tiers offered for a handle, in canonical order. */
export function reasoningTiers(
  entries: LettaCodeModelEntry[],
  handle: string | undefined,
): string[] {
  if (!handle) return [];
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.handle !== handle) continue;
    const effort = entryReasoningEffort(entry);
    if (effort) found.add(effort);
  }
  const known = REASONING_EFFORT_ORDER.filter((effort) => found.has(effort));
  const extra = [...found].filter(
    (effort) => !(REASONING_EFFORT_ORDER as readonly string[]).includes(effort),
  );
  return [...known, ...extra];
}

/**
 * Build the thought-level config option, or null when the active model does not
 * offer a choice — a single-tier selector would only be noise.
 */
export function thoughtLevelConfigOption(
  entries: LettaCodeModelEntry[],
  handle: string | undefined,
  current: string | undefined,
): SessionConfigOption | null {
  const tiers = reasoningTiers(entries, handle);
  if (tiers.length < 2) return null;
  const currentValue = current && tiers.includes(current) ? current : tiers[0];
  return {
    id: THOUGHT_LEVEL_CONFIG_ID,
    name: "Thinking",
    description: "Reasoning effort for the active model",
    category: "thought_level",
    type: "select",
    currentValue,
    options: tiers.map((effort) => ({
      value: effort,
      name: EFFORT_LABELS[effort] ?? effort,
    })),
  };
}
