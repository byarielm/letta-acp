import type { LettaCodeSession, SDKMessage } from "@letta-ai/letta-agent-sdk";

const RECENT_RUN_LIMIT = 1024;

export type SessionEvent =
  | { message: SDKMessage; forwarded: boolean; stale?: boolean }
  | { message: null; forwarded: false; error?: unknown };

/** A prompt observes delivery; it never owns the SDK iterator. */
export class PromptEvents {
  hasActivity = false;
  private queue: SessionEvent[] = [];
  private waiter?: (event: SessionEvent | undefined) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly priorRunIds: ReadonlySet<string> = new Set()) {}

  isPriorRun(message: SDKMessage): boolean {
    const runIds = messageRunIds(message);
    return runIds.length > 0 && runIds.every((id) => this.priorRunIds.has(id));
  }

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      if (event.forwarded && !event.stale) this.hasActivity = true;
      const resolve = this.waiter;
      this.waiter = undefined;
      clearTimeout(this.timer);
      resolve(event);
    } else {
      this.queue.push(event);
    }
  }

  next(deadlineMs?: number): Promise<SessionEvent | undefined> {
    const event = this.queue.shift();
    if (event) {
      if (event.forwarded && !event.stale) this.hasActivity = true;
      return Promise.resolve(event);
    }
    if (this.closed) return Promise.resolve(undefined);
    if (this.waiter) throw new Error("Concurrent prompt event reads");
    return new Promise((resolve) => {
      this.waiter = resolve;
      if (deadlineMs !== undefined) {
        this.timer = setTimeout(() => {
          this.waiter = undefined;
          resolve(undefined);
        }, deadlineMs);
      }
    });
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    clearTimeout(this.timer);
    this.waiter?.(undefined);
    this.waiter = undefined;
  }
}

/** Exactly one SDK reader for the session, including between user prompts. */
export class SessionReader {
  private observer?: PromptEvents;
  private stopped = false;
  private terminal?: SessionEvent;
  private readonly seenRunIds = new Set<string>();
  readonly done: Promise<void>;

  constructor(
    session: LettaCodeSession,
    forward: (message: SDKMessage) => Promise<boolean>,
    onError: (error: unknown) => void,
  ) {
    this.done = this.run(session, forward).catch((error) => {
      if (this.stopped) return;
      this.finish({ message: null, forwarded: false, error });
      onError(error);
    });
  }

  observe(): PromptEvents {
    if (this.observer) throw new Error("Session already has an active prompt");
    const observer = new PromptEvents(new Set(this.seenRunIds));
    this.observer = observer;
    if (this.terminal) observer.push(this.terminal);
    return observer;
  }

  release(observer: PromptEvents): void {
    if (this.observer === observer) this.observer = undefined;
    observer.close();
  }

  stop(): void {
    this.stopped = true;
    this.finish({ message: null, forwarded: false });
  }

  private finish(event: SessionEvent): void {
    this.terminal = event;
    this.observer?.push(event);
  }

  private async run(
    session: LettaCodeSession,
    forward: (message: SDKMessage) => Promise<boolean>,
  ): Promise<void> {
    while (!this.stopped) {
      let sawResult = false;
      for await (const message of session.stream()) {
        if (this.stopped) return;
        // Capture before forwarding: a later prompt must not inherit an event
        // whose client notification was still in flight when it subscribed.
        const observer = this.observer;
        const stale = observer?.isPriorRun(message) ?? false;
        for (const id of messageRunIds(message)) {
          this.seenRunIds.add(id);
          if (this.seenRunIds.size > RECENT_RUN_LIMIT) {
            this.seenRunIds.delete(this.seenRunIds.values().next().value!);
          }
        }
        const forwarded = await forward(message);
        // Old work remains visible, but cannot settle or count as activity for
        // a newly submitted prompt (including a replacement after cancel).
        observer?.push({ message, forwarded: forwarded && !stale, stale });
        if (message.type === "result") sawResult = true;
      }
      // SDK stream() ends at each result; only an empty/closed stream ends
      // conversation delivery. Re-arm without waiting for another user prompt.
      if (!sawResult) break;
    }
    this.finish({ message: null, forwarded: false });
  }
}

function messageRunIds(message: SDKMessage): readonly string[] {
  if (message.type === "result") return message.runIds ?? [];
  if (message.type === "loop_status") return message.activeRunIds;
  if ("runId" in message && typeof message.runId === "string") return [message.runId];
  if (message.type === "stream_event" && typeof message.event.run_id === "string") {
    return [message.event.run_id];
  }
  return [];
}
