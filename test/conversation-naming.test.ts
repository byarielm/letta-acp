import { describe, expect, test } from "bun:test";
import { ConversationNamer, type NamingDependencies } from "../src/conversation-naming.js";
import type { NamingConfig, TitleMessage } from "../src/conversation-title.js";

const config: NamingConfig = { mode: "local", model: "test-model", endpoint: "http://127.0.0.1:11434", afterTurns: 3, timeoutMs: 1_000 };
const exchange: TitleMessage[] = [{ role: "user", content: "Improve conversation names" }, { role: "assistant", content: "Use a separate naming model" }];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(options: Partial<NamingConfig> = {}, overrides: Partial<NamingDependencies> = {}) {
  let summary: string | null = null;
  let messages = [...exchange];
  let calls = 0;
  const writes: string[] = [];
  const notifications: string[] = [];
  const logs: string[] = [];
  const namer = new ConversationNamer({ ...config, ...options }, {
    retrieve: async () => ({ summary }),
    update: async (title) => { writes.push(title); summary = title; },
    history: async () => messages,
    subscriptionGenerate: async () => "Hosted conversation title",
    titleChanged: async (title) => { notifications.push(title); },
    isCurrent: () => true,
    log: (message) => { logs.push(message); },
    generate: async () => { calls++; return "Better Conversation Names"; },
    ...overrides,
  });
  return { namer, writes, notifications, logs,
    setSummary(value: string) { summary = value; },
    setMessages(value: TitleMessage[]) { messages = value; },
    get calls() { return calls; },
  };
}

describe("conversation naming lifecycle", () => {
  test("waits for substantive exchanges and auto-names only once", async () => {
    const f = fixture();
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.writes).toEqual([]);
    f.setMessages([...exchange, ...exchange, ...exchange]);
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.writes).toEqual(["Better Conversation Names"]);
    expect(f.notifications).toEqual(f.writes);
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.calls).toBe(1);
  });

  test("does not overwrite an existing title when a session resumes", async () => {
    const f = fixture({ afterTurns: 1 });
    f.setSummary("My deliberately chosen title");
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.writes).toEqual([]);
    expect(f.calls).toBe(0);
  });

  test("counts completed foreground turns when a bounded history window omits earlier exchanges", async () => {
    const f = fixture();
    f.namer.maybeAutoTitle(); await flush();
    f.namer.maybeAutoTitle(); await flush();
    expect(f.writes).toEqual([]);
    f.namer.maybeAutoTitle(); await flush();
    expect(f.writes).toEqual(["Better Conversation Names"]);
  });

  test("manual retitle bypasses the automatic threshold", async () => {
    const f = fixture();
    expect(await f.namer.retitle("Focus on ACP naming")).toBe("Better Conversation Names");
    expect(f.writes).toEqual(["Better Conversation Names"]);
  });

  test("rename works with naming off and does not call a model", async () => {
    const f = fixture({ mode: "off" });
    expect(await f.namer.rename("ACP naming #2")).toBe("ACP naming #2");
    expect(f.calls).toBe(0);
    expect(f.writes).toEqual(["ACP naming #2"]);
    await expect(f.namer.rename("x".repeat(101))).rejects.toThrow("1–100");
    await expect(f.namer.retitle()).rejects.toThrow("off");
  });

  test("a manual rename supersedes a pending automatic generation", async () => {
    let finish!: (title: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const f = fixture({ afterTurns: 1 }, { generate: async () => pending });
    f.namer.maybeAutoTitle();
    await flush();
    await f.namer.rename("Keep this exact name");
    finish("Stale automatic title");
    await flush();
    expect(f.writes).toEqual(["Keep this exact name"]);
  });

  test("preserves an externally changed title during generation", async () => {
    let finish!: (title: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const f = fixture({}, { generate: async () => pending });
    const result = f.namer.retitle();
    await flush();
    f.setSummary("Changed in another client");
    finish("Generated name");
    await expect(result).rejects.toThrow("newer title was preserved");
    expect(f.writes).toEqual([]);
  });

  test("closing or replacing a runtime prevents a late title write", async () => {
    let finish!: (title: string) => void;
    const f = fixture({ afterTurns: 1 }, { generate: () => new Promise((resolve) => { finish = resolve; }) });
    f.namer.maybeAutoTitle();
    await flush();
    f.namer.close();
    finish("Too late");
    await flush();
    expect(f.writes).toEqual([]);
    expect(f.notifications).toEqual([]);
  });

  test("free-only hosted failures use the configured local model, never a paid fallback", async () => {
    const seen: NamingConfig[] = [];
    const f = fixture({ mode: "subscription", model: "hosted/free", requireFree: true, localModel: "my-qwen" }, {
      generate: async (choice) => {
        seen.push(choice);
        if (choice.mode === "subscription") throw new Error("No longer free");
        return "Local Fallback Title";
      },
    });
    expect(await f.namer.retitle()).toBe("Local Fallback Title");
    expect(seen.map((choice) => choice.model)).toEqual(["hosted/free", "my-qwen"]);
    expect(f.logs[0]).toContain("using local naming");
  });

  test("generation failure leaves the conversation untitled and can retry", async () => {
    let fail = true;
    const f = fixture({ afterTurns: 1 }, { generate: async () => {
      if (fail) throw new Error("Ollama unavailable");
      return "Recovered Title";
    } });
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.writes).toEqual([]);
    fail = false;
    f.namer.maybeAutoTitle();
    await flush();
    expect(f.writes).toEqual(["Recovered Title"]);
  });

  test("mode changes keep the local and hosted models separate", () => {
    const f = fixture({ mode: "subscription", model: "my-subscription", localModel: "my-qwen" });
    f.namer.setMode("local");
    expect(f.namer.config.model).toBe("my-qwen");
    f.namer.setMode("subscription");
    expect(f.namer.config.model).toBe("my-subscription");
    f.namer.setMode("local");
    f.namer.setModel("another-local-model");
    f.namer.setMode("subscription");
    expect(f.namer.config.model).toBe("my-subscription");
    f.namer.setMode("local");
    expect(f.namer.config.model).toBe("another-local-model");
    expect(f.namer.config.localModel).toBe("another-local-model");
  });

  test("a backend write already in flight completes before a newer exact rename", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstWrite = new Promise<void>((resolve) => { started = resolve; });
    const persisted: string[] = [];
    const f = fixture({ afterTurns: 1 }, { update: async (title) => {
      if (persisted.length === 0) { started(); await gate; }
      persisted.push(title);
    } });
    f.namer.maybeAutoTitle();
    await firstWrite;
    const rename = f.namer.rename("Exact newer name");
    release();
    await rename;
    expect(persisted).toEqual(["Better Conversation Names", "Exact newer name"]);
    expect(f.notifications.at(-1)).toBe("Exact newer name");
  });
});
