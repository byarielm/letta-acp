import { describe, expect, test } from "bun:test";
import {
  generateTitle,
  heuristicTitle,
  namingConfigFromEnv,
  normalizeTitle,
  titleMessagesFromHistory,
  titlePrompt,
  type NamingConfig,
} from "../src/conversation-title.js";

const base: NamingConfig = { mode: "local", model: "test-model", endpoint: "http://127.0.0.1:11434", afterTurns: 3, timeoutMs: 1_000 };

describe("namingConfigFromEnv", () => {
  test("accepts concise Auto and Cloud method names without breaking legacy settings", () => {
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_MODE: "auto" }).mode).toBe("message");
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_MODE: "cloud", LETTA_ACP_NAMING_MODEL: "hosted/free" }).mode).toBe("subscription");
  });
  test("provides defaults and local model", () => {
    expect(namingConfigFromEnv({})).toEqual({ mode: "message", endpoint: "http://127.0.0.1:11434", afterTurns: 3, timeoutMs: 60_000,
      localModel: "qwen3.5:9b-q4_K_M", requireFree: false });
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_MODE: "local" }).model).toBe("qwen3.5:9b-q4_K_M");
  });
  test("requires explicit subscription model and validates endpoint", () => {
    expect(() => namingConfigFromEnv({ LETTA_ACP_NAMING_MODE: "subscription" })).toThrow(/requires/);
    expect(() => namingConfigFromEnv({ LETTA_ACP_NAMING_ENDPOINT: "file:///tmp" })).toThrow(/HTTP/);
    expect(() => namingConfigFromEnv({ LETTA_ACP_NAMING_ENDPOINT: "https://user:pass@example.com" })).toThrow(/userinfo/);
  });
  test("uses valid positive turns and bounds timeout", () => {
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_AFTER_TURNS: "5", LETTA_ACP_NAMING_TIMEOUT_MS: "9999999" })).toMatchObject({ afterTurns: 5, timeoutMs: 300_000 });
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_AFTER_TURNS: "0" }).afterTurns).toBe(3);
  });
  test("free-only hosted naming retains an explicit local fallback", () => {
    expect(namingConfigFromEnv({ LETTA_ACP_NAMING_MODE: "subscription", LETTA_ACP_NAMING_MODEL: "hosted/free",
      LETTA_ACP_NAMING_REQUIRE_FREE: "true", LETTA_ACP_NAMING_LOCAL_MODEL: "custom-qwen" }))
      .toMatchObject({ requireFree: true, localModel: "custom-qwen", model: "hosted/free" });
    expect(() => namingConfigFromEnv({ LETTA_ACP_NAMING_REQUIRE_FREE: "maybe" })).toThrow("true or false");
  });
});

describe("history extraction and titles", () => {
  test("keeps human text and assistant responses only", () => {
    const messages = titleMessagesFromHistory([
      { message_type: "user_message", content: "Help me fix the parser" },
      { message_type: "user_message", content: '{"type":"heartbeat","content":"internal"}' },
      { message_type: "user_message", content: "/clear" },
      { message_type: "user_message", content: "Please help <system-reminder>private</system-reminder>" },
      { message_type: "assistant_message", content: [{ type: "text", text: "I will inspect it." }, { type: "image", url: "secret" }] },
      { message_type: "reasoning_message", content: "hidden reasoning" },
      { message_type: "tool_call_message", content: "tool" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Help me fix the parser" },
      { role: "user", content: "Please help" },
      { role: "assistant", content: "I will inspect it." },
    ]);
  });
  test("normalizes plain titles and rejects explanations or thinking", () => {
    expect(normalizeTitle('**"Fix parser errors"**')).toBe("Fix parser errors");
    expect(normalizeTitle("<think>should not surface</think> Real title")).toBe("Real title");
    expect(normalizeTitle("Thinking About Conversation Naming")).toBe("Thinking About Conversation Naming");
    expect(normalizeTitle("Here is the title: Parser fix")).toBeNull();
    expect(normalizeTitle("line one\nline two")).toBeNull();
    expect(normalizeTitle("x".repeat(120))).toHaveLength(100);
    expect(heuristicTitle([{ role: "assistant", content: "hello" }, { role: "user", content: "  Add a dark mode toggle  " }])).toBe("Add a dark mode toggle");
  });
  test("bounds transcript while retaining beginning and recent context", () => {
    const prompt = titlePrompt([{ role: "user", content: "opening" }, ...Array.from({ length: 30 }, (_, i) => ({ role: "assistant" as const, content: `${i}: ${"x".repeat(1_000)}` }))]);
    expect(prompt.length).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("opening");
    expect(prompt).toContain("29:");
    expect(prompt).toContain("untrusted data");
  });
});

describe("generateTitle", () => {
  test("message mode uses heuristic and off rejects", async () => {
    expect(await generateTitle({ ...base, mode: "message" }, [{ role: "user", content: "Explain async iterators" }])).toBe("Explain async iterators");
    await expect(generateTitle({ ...base, mode: "off" }, [])).rejects.toThrow(/disabled/);
  });
  test("subscription callback receives separate system and user prompt", async () => {
    const title = await generateTitle({ ...base, mode: "subscription" }, [{ role: "user", content: "Plan a garden" }], "Short", async (system, prompt, signal) => {
      expect(system).toContain("untrusted");
      expect(prompt).toContain("Short");
      expect(signal).toBeInstanceOf(AbortSignal);
      return "Garden planning";
    });
    expect(title).toBe("Garden planning");
  });
  test("local sends constrained Ollama request and parses response", async () => {
    const originalFetch = globalThis.fetch;
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: "\"Fix the build\"" } }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await generateTitle(base, [{ role: "user", content: "Build fails" }])).toBe("Fix the build");
      expect(request).toMatchObject({ stream: false, think: false, keep_alive: "30s", options: { num_ctx: 8192, num_predict: 64, temperature: 0.2 } });
    } finally { globalThis.fetch = originalFetch; }
  });
  test("local timeout is enforced even for uncooperative callback", async () => {
    await expect(generateTitle({ ...base, mode: "subscription", timeoutMs: 10 }, [{ role: "user", content: "x" }], undefined, () => new Promise(() => {}))).rejects.toThrow(/timed out/);
  });
  test("caller cancellation stops waiting even for an uncooperative callback", async () => {
    const controller = new AbortController();
    const result = generateTitle({ ...base, mode: "subscription" }, [{ role: "user", content: "x" }],
      undefined, () => new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("abort");
  });
  test.each([500, 404])("reports local HTTP %s without exposing the response body", async (status) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("PRIVATE PROVIDER BODY", { status })) as unknown as typeof fetch;
    try {
      await expect(generateTitle(base, [{ role: "user", content: "A topic" }])).rejects.toThrow(`HTTP ${status}`);
    } finally { globalThis.fetch = originalFetch; }
  });
});
