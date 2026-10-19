import { expect, test } from "bun:test";
import type { LettaCodeSession, SDKMessage } from "@letta-ai/letta-agent-sdk";
import { PromptEvents, SessionReader } from "../src/session-reader.js";

const reply = (text: string): SDKMessage => ({
  type: "assistant", content: text, uuid: text,
});

test("an expired grace read cannot steal the next event", async () => {
  const events = new PromptEvents();
  expect(await events.next(1)).toBeUndefined();
  const event = { message: reply("late"), forwarded: true };
  events.push(event);
  expect(await events.next()).toBe(event);
  events.close();
});

test("releasing an observer settles its pending read and discards queued events", async () => {
  const events = new PromptEvents();
  const pending = events.next();
  events.close();
  expect(await pending).toBeUndefined();
  events.push({ message: reply("obsolete"), forwarded: true });
  expect(await events.next()).toBeUndefined();
});

function fixture(forward: (message: SDKMessage) => Promise<boolean>) {
  const input = new PromptEvents();
  let activeReaders = 0;
  let maxReaders = 0;
  const session = {
    async *stream() {
      activeReaders += 1;
      maxReaders = Math.max(maxReaders, activeReaders);
      try {
        while (true) {
          const event = await input.next();
          if (!event?.message) return;
          yield event.message;
          if (event.message.type === "result") return;
        }
      } finally {
        activeReaders -= 1;
      }
    },
  } as unknown as LettaCodeSession;
  const errors: unknown[] = [];
  const reader = new SessionReader(session, forward, (error) => errors.push(error));
  return {
    reader, errors,
    push: (message: SDKMessage) => input.push({ message, forwarded: false }),
    maxReaders: () => maxReaders,
    close: async () => { reader.stop(); input.close(); await reader.done; },
  };
}

test("one reader re-arms after results and delivers while no prompt observes", async () => {
  const delivered: SDKMessage[] = [];
  let backgroundDelivered!: () => void;
  const backgroundDone = new Promise<void>((resolve) => { backgroundDelivered = resolve; });
  const f = fixture(async (message) => {
    delivered.push(message);
    if (message.type === "assistant" && message.content === "background") backgroundDelivered();
    return true;
  });
  try {
    const observer = f.reader.observe();
    const result: SDKMessage = {
      type: "result", success: true, durationMs: 0, conversationId: "conv-test",
    };
    f.push(result);
    expect((await observer.next())?.message).toBe(result);
    f.reader.release(observer);
    f.push(reply("background"));
    await backgroundDone;
    const next = f.reader.observe();
    const barrier = reply("barrier");
    f.push(barrier);
    expect((await next.next())?.message).toBe(barrier);
    expect(delivered.filter((message) => message.type === "assistant")).toHaveLength(2);
    expect(f.maxReaders()).toBe(1);
    f.reader.release(next);
  } finally { await f.close(); }
});

test("a new observer does not inherit a notification already being delivered", async () => {
  let started!: () => void;
  let finish!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture(async () => { started(); await gate; return true; });
  try {
    f.push(reply("before prompt"));
    await began;
    const observer = f.reader.observe();
    finish();
    expect(await observer.next(5)).toBeUndefined();
    f.reader.release(observer);
  } finally { finish(); await f.close(); }
});

test("delivery failure settles an active observer and remains visible to later observers", async () => {
  const failure = new Error("client disconnected");
  const f = fixture(async () => { throw failure; });
  try {
    const observer = f.reader.observe();
    expect(() => f.reader.observe()).toThrow("active prompt");
    f.push(reply("undeliverable"));
    expect(await observer.next()).toEqual({ message: null, forwarded: false, error: failure });
    await f.reader.done;
    f.reader.release(observer);
    const later = f.reader.observe();
    expect(await later.next()).toEqual({ message: null, forwarded: false, error: failure });
    f.reader.release(later);
    expect(f.errors).toEqual([failure]);
  } finally { await f.close(); }
});
