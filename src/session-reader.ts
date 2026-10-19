import type { LettaCodeSession, SDKMessage } from "@letta-ai/letta-agent-sdk";

export type SessionEvent =
  | { message: SDKMessage; forwarded: boolean }
  | { message: null; forwarded: false; error?: unknown };

/** A prompt observes delivery; it never owns the SDK iterator. */
export class PromptEvents {
  private queue: SessionEvent[] = [];
  private waiter?: (event: SessionEvent | undefined) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.waiter) {
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
    if (event) return Promise.resolve(event);
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
    const observer = new PromptEvents();
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
        const forwarded = await forward(message);
        observer?.push({ message, forwarded });
        if (message.type === "result") sawResult = true;
      }
      // SDK stream() ends at each result; only an empty/closed stream ends
      // conversation delivery. Re-arm without waiting for another user prompt.
      if (!sawResult) break;
    }
    this.finish({ message: null, forwarded: false });
  }
}
