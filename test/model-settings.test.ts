import { describe, expect, test } from "bun:test";
import { modelSnapshot } from "../src/model-settings.js";

describe("persisted model settings", () => {
  test("reads current agent fields and preserves model/context settings", () => {
    expect(modelSnapshot({
      model: "openai/model",
      context_window_limit: 128_000,
      model_settings: { reasoning: { reasoning_effort: "high" } },
    })).toEqual({ model: "openai/model", reasoningEffort: "high", contextWindow: 128_000 });
  });

  test("conversation model and context limits override agent values", () => {
    expect(modelSnapshot({
      model: "openai/model", context_window_limit: 128_000,
      model_settings: { reasoning: { reasoning_effort: "high" } },
    }, {
      model: "openai/model", context_window_limit: 1_000_000,
      model_settings: { reasoning: { reasoning_effort: "low" } },
    })).toEqual({ model: "openai/model", reasoningEffort: "low", contextWindow: 1_000_000 });
  });

  test("empty and null conversation settings fall back; malformed reads are rejected", () => {
    const agent = { model: "openai/model", model_settings: { reasoning_effort: "medium", context_window_limit: 64_000 } };
    expect(modelSnapshot(agent, { model_settings: {} })).toEqual({ model: "openai/model", reasoningEffort: "medium", contextWindow: 64_000 });
    expect(modelSnapshot(agent, { model_settings: null })).toEqual({ model: "openai/model", reasoningEffort: "medium", contextWindow: 64_000 });
    expect(modelSnapshot(agent, { model_settings: "bad" })).toBeUndefined();
  });

  test("explicit null or disabled reasoning clears inherited effort", () => {
    const agent = { model: "openai/model", model_settings: { reasoning: { reasoning_effort: "high" } } };
    expect(modelSnapshot(agent, { model_settings: { reasoning: null } })).toEqual({ model: "openai/model" });
    expect(modelSnapshot(agent, { model_settings: { reasoning: { reasoning_effort: null } } })).toEqual({ model: "openai/model" });
    expect(modelSnapshot(agent, { model_settings: { thinking: { type: "disabled" } } }))
      .toEqual({ model: "openai/model", reasoningEffort: "none" });
    expect(modelSnapshot(agent, { model_settings: { enable_reasoner: false } }))
      .toEqual({ model: "openai/model", reasoningEffort: "none" });
  });

  test("a conversation provider switch does not inherit the agent's tier", () => {
    expect(modelSnapshot({ model: "openai/model", model_settings: { reasoning_effort: "high" } }, {
      model: "anthropic/model",
    })).toEqual({ model: "anthropic/model" });
    expect(modelSnapshot({ model: "openai/model", model_settings: { reasoning_effort: "high" } }, {
      model: "anthropic/model", model_settings: { thinking: { type: "disabled" } },
    })).toEqual({ model: "anthropic/model", reasoningEffort: "none" });
  });

  test("an explicit scoped tier replaces inherited disabled flags and alternate selector spellings", () => {
    expect(modelSnapshot({ model: "test/model", model_settings: { enable_reasoner: false, effort: null } }, {
      model_settings: { reasoning: { reasoning_effort: "high" } },
    })).toEqual({ model: "test/model", reasoningEffort: "high" });
    expect(modelSnapshot({ model: "test/model", model_settings: { reasoning: { reasoning_effort: "high" } } }, {
      model_settings: { effort: "low" },
    })).toEqual({ model: "test/model", reasoningEffort: "low" });
  });

  test("malformed model and context records cannot clear a known state", () => {
    expect(modelSnapshot({ model: 4 })).toBeUndefined();
    expect(modelSnapshot({ model: "test/model", context_window_limit: -1 })).toBeUndefined();
    expect(modelSnapshot({ model: "test/model" }, { context_window_limit: "large" })).toBeUndefined();
    expect(modelSnapshot({ model: "test/model", model_settings: { context_window_limit: -1 } })).toBeUndefined();
  });

  test("uses verified legacy agent settings but does not guess legacy model handles", () => {
    expect(modelSnapshot({
      model: "openai/model",
      llm_config: { model_settings: { reasoning_effort: "low" }, context_window: 32_000 },
    })).toEqual({ model: "openai/model", reasoningEffort: "low", contextWindow: 32_000 });
    expect(modelSnapshot({ llm_config: { model: "not-a-verified-handle" } })).toEqual({});
  });

  test("missing and malformed records do not invent defaults", () => {
    expect(modelSnapshot(null)).toBeUndefined();
    expect(modelSnapshot({ id: "agent-without-settings" })).toEqual({});
    expect(modelSnapshot({ model: "openai/model", model_settings: { reasoning: 4 } }))
      .toBeUndefined();
  });
});
