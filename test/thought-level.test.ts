import { describe, expect, test } from "bun:test";
import {
  reasoningTiers,
  thoughtLevelConfigOption,
} from "../src/thought-level.js";

interface CatalogEntry {
  id: string;
  handle: string;
  label: string;
  description?: string;
  updateArgs?: Record<string, unknown>;
}

const entry = (
  id: string,
  handle: string,
  effort?: string,
): CatalogEntry => ({
  id,
  handle,
  label: handle,
  description: "",
  ...(effort ? { updateArgs: { reasoning_effort: effort } } : {}),
});

const reasoning: CatalogEntry[] = [
  entry("gpt-6-astra-low", "openai/gpt-6-astra", "low"),
  entry("gpt-6-astra-medium", "openai/gpt-6-astra", "medium"),
  entry("gpt-6-astra", "openai/gpt-6-astra"),
  entry("gpt-6-astra-high", "openai/gpt-6-astra", "high"),
  entry("gpt-6-astra-xhigh", "openai/gpt-6-astra", "xhigh"),
  entry("gpt-6-astra-max", "openai/gpt-6-astra", "max"),
  entry("auto", "letta/auto"),
];

describe("thought level options", () => {
  test("computes reasoning tiers for a reasoning model", () => {
    expect(reasoningTiers(reasoning as any, "openai/gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("returns no tiers for a non-reasoning model", () => {
    expect(reasoningTiers(reasoning as any, "letta/auto")).toEqual([]);
  });

  test("builds a thought-level select option", () => {
    expect(
      thoughtLevelConfigOption(reasoning as any, "openai/gpt-6-astra", "high"),
    ).toEqual({
      id: "thought_level",
      name: "Thinking",
      description: "Reasoning effort for the active model",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra high" },
        { value: "max", name: "Max" },
      ],
    });
  });

  test("returns null for a non-reasoning model", () => {
    expect(
      thoughtLevelConfigOption(reasoning as any, "letta/auto", undefined),
    ).toBeNull();
  });
});
