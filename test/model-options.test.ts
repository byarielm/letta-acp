import { describe, expect, test } from "bun:test";
import {
  collapseVariants,
  groupedModelOptions,
  variantOf,
} from "../src/model-options.js";

interface CatalogEntry {
  id: string;
  handle: string;
  label: string;
  description?: string;
  updateArgs?: Record<string, unknown>;
  isFeatured?: boolean;
}

const e = (
  id: string,
  handle: string,
  label: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): CatalogEntry => ({
  id,
  handle,
  label,
  description: "",
  ...extra,
  ...(Object.keys(args).length ? { updateArgs: args } : {}),
});

const catalog: CatalogEntry[] = [
  e("gpt-6-astra-low", "openai/gpt-6-astra", "GPT-6 Astra", { reasoning_effort: "low", context_window: 350000 }),
  e("gpt-6-astra-medium", "openai/gpt-6-astra", "GPT-6 Astra", { reasoning_effort: "medium", context_window: 350000 }),
  e("gpt-6-astra", "openai/gpt-6-astra", "GPT-6 Astra", { context_window: 350000 }, { isFeatured: true }),
  e("gpt-6-astra-xhigh", "openai/gpt-6-astra", "GPT-6 Astra", { reasoning_effort: "xhigh", context_window: 350000 }),
  e("gpt-6-astra-max", "openai/gpt-6-astra", "GPT-6 Astra", { reasoning_effort: "max", context_window: 350000 }),
  e("gpt-6-astra-1m-low", "openai/gpt-6-astra", "GPT-6 Astra 1M", { reasoning_effort: "low", context_window: 950000 }),
  e("gpt-6-astra-1m", "openai/gpt-6-astra", "GPT-6 Astra 1M", { context_window: 950000 }, { isFeatured: true }),
  e("gpt-6-astra-1m-max", "openai/gpt-6-astra", "GPT-6 Astra 1M", { reasoning_effort: "max", context_window: 950000 }),
  e("opus-4.6-high", "anthropic/claude-opus-4-6", "Claude Opus 4.6", { reasoning_effort: "high", context_window: 200000 }),
  e("opus-4.6-no-reasoning", "anthropic/claude-opus-4-6", "Claude Opus 4.6", { reasoning_effort: "none", context_window: 200000 }),
  e("opus-4.6-low", "anthropic/claude-opus-4-6", "Claude Opus 4.6", { reasoning_effort: "low", context_window: 200000 }),
  e("gpt-6-astra-plus-pro-high", "chatgpt-plus-pro/gpt-6-astra", "GPT-6 Astra (ChatGPT)", { reasoning_effort: "high", context_window: 350000 }),
  e("deep-research", "google_ai/deep-research-max", "Deep Research Max (Apr-21-2026)", { context_window: 1000000 }),
  e("auto", "letta/auto", "Auto", { context_window: 140000 }),
];

describe("model option collapsing and grouping", () => {
  test("collapses variants by handle and context window", () => {
    const variants = collapseVariants(catalog as any);
    expect(variants.map((v) => v.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-astra-1m",
      "opus-4.6-high",
      "gpt-6-astra-plus-pro-high",
      "deep-research",
      "auto",
    ]);
  });

  test("maps an entry to its collapsed variant", () => {
    const variants = collapseVariants(catalog as any);
    expect(variantOf(catalog[4] as any, variants)?.id).toBe("gpt-6-astra");
    expect(variantOf(catalog[10] as any, variants)?.id).toBe("opus-4.6-high");
  });

  test("groups variants by provider with display names", () => {
    const variants = collapseVariants(catalog as any);
    const groups = groupedModelOptions(variants);
    expect(
      groups.map((g) => ({ group: g.group, name: g.name, models: g.options.map((o) => o.name) })),
    ).toEqual([
      { group: "openai", name: "OpenAI", models: ["GPT-6 Astra", "GPT-6 Astra 1M"] },
      { group: "anthropic", name: "Anthropic", models: ["Claude Opus 4.6"] },
      { group: "chatgpt-plus-pro", name: "ChatGPT", models: ["GPT-6 Astra"] },
      { group: "google_ai", name: "Google", models: ["Deep Research Max (Apr-21-2026)"] },
      { group: "letta", name: "Letta", models: ["Auto"] },
    ]);
  });
});
