import {
  generateTitle,
  type NamingConfig,
  type NamingMode,
  type TitleMessage,
} from "./conversation-title.js";

interface ConversationTitleState {
  summary?: string | null;
  archived?: boolean;
}

export interface NamingDependencies {
  retrieve(): Promise<ConversationTitleState>;
  update(title: string): Promise<void>;
  history(): Promise<TitleMessage[]>;
  subscriptionGenerate(model: string, system: string, prompt: string, signal: AbortSignal, requireFree: boolean): Promise<string>;
  titleChanged(title: string): Promise<void>;
  isCurrent(): boolean;
  log(message: string): void;
  generate?: typeof generateTitle;
}

/** Title work is independent of the agent's model turn and never owns its stream. */
export class ConversationNamer {
  config: NamingConfig;
  private readonly models = new Map<NamingMode, string>();
  private revision = 0;
  private controller?: AbortController;
  private automatic?: Promise<void>;
  private autoComplete = false;
  private closed = false;
  private completedTurns = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(config: NamingConfig, private readonly deps: NamingDependencies) {
    this.config = { ...config };
    if (config.model) this.models.set(config.mode, config.model);
  }

  setMode(mode: NamingMode): void {
    this.cancel();
    this.config = { ...this.config, mode,
      model: this.models.get(mode) ?? (mode === "local" ? this.config.localModel ?? "qwen3.5:9b-q4_K_M" : undefined),
    };
  }

  setModel(model: string): void {
    this.cancel();
    this.models.set(this.config.mode, model);
    this.config = { ...this.config, model, ...(this.config.mode === "local" ? { localModel: model } : {}) };
  }

  /** Called once after each successful, substantive foreground user turn. */
  maybeAutoTitle(): void {
    this.completedTurns++;
    if (this.closed || this.autoComplete || this.automatic || this.config.mode === "off") return;
    const job = this.runGeneration(false).then(() => {}).catch((error) => {
      if (!this.closed && !(error instanceof Error && error.name === "AbortError")) {
        this.deps.log(`Automatic conversation naming failed: ${String(error)}`);
      }
    });
    this.automatic = job;
    void job.finally(() => { if (this.automatic === job) this.automatic = undefined; });
  }

  async retitle(hint?: string): Promise<string> {
    if (this.config.mode === "off") throw new Error("Conversation naming is off. Choose a naming mode or use /rename <exact title>.");
    if (this.config.mode === "message" && hint) {
      throw new Error("Message-based naming cannot interpret guidance. Choose a model naming mode or use /rename <exact title>.");
    }
    const title = await this.runGeneration(true, hint);
    if (!title) throw new Error("No substantive conversation messages are available to name yet.");
    return title;
  }

  async rename(title: string): Promise<string> {
    const exact = title.trim();
    if (!exact || [...exact].length > 100 || /[\r\n\x00-\x1f\x7f]/.test(exact)) {
      throw new Error("Usage: /rename <exact title> — use one line of 1–100 characters.");
    }
    this.cancel();
    const revision = this.revision;
    this.assertCurrent(revision);
    await this.persist(exact, revision);
    this.autoComplete = true;
    if (this.isCurrent(revision)) await this.notify(exact);
    return exact;
  }

  cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  private async runGeneration(manual: boolean, hint?: string): Promise<string | undefined> {
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const config = { ...this.config };
    this.assertCurrent(revision);
    const original = await this.deps.retrieve();
    this.assertCurrent(revision);
    if (original.archived) throw new Error("Cannot name an archived conversation.");
    if (!manual && original.summary?.trim()) {
      this.autoComplete = true;
      return;
    }
    const messages = await this.deps.history();
    this.assertCurrent(revision);
    if (!manual && Math.max(this.completedTurns, completedExchanges(messages)) < config.afterTurns) return;
    if (!messages.some((message) => message.role === "user")) return;
    const generate = this.deps.generate ?? generateTitle;
    let title: string;
    try {
      title = await generate(config, messages, hint,
        (system, prompt, signal) => {
          if (!config.model) throw new Error("Select a naming model or set LETTA_ACP_NAMING_MODEL.");
          return this.deps.subscriptionGenerate(config.model, system, prompt, signal, config.requireFree === true);
        }, controller.signal);
    } catch (error) {
      this.assertCurrent(revision);
      if (config.mode !== "subscription" || !config.requireFree) throw error;
      // A free-only policy never silently spends credits. Use the explicitly
      // configured local fallback when free eligibility or inference fails.
      this.deps.log(`Free hosted naming unavailable; using local naming: ${String(error)}`);
      title = await generate({ ...config, mode: "local", model: config.localModel ?? "qwen3.5:9b-q4_K_M" },
        messages, hint, undefined, controller.signal);
    }
    this.assertCurrent(revision);
    const current = await this.deps.retrieve();
    this.assertCurrent(revision);
    if (current.archived || (current.summary ?? "") !== (original.summary ?? "")) {
      throw new Error("The conversation title changed while generating a name; the newer title was preserved.");
    }
    await this.persist(title, revision);
    this.autoComplete = true;
    if (this.isCurrent(revision)) await this.notify(title);
    return title;
  }

  private async notify(title: string): Promise<void> {
    try { await this.deps.titleChanged(title); }
    catch (error) { this.deps.log(`Conversation title saved, but editor notification failed: ${String(error)}`); }
  }

  private async persist(title: string, revision: number): Promise<void> {
    // A request already accepted by the backend cannot be unsent. Serialize
    // writes so a later explicit rename is always applied after an older job.
    const write = this.writes.catch(() => {}).then(async () => {
      this.assertCurrent(revision);
      await this.deps.update(title);
    });
    this.writes = write;
    await write;
  }

  private isCurrent(revision: number): boolean {
    return !this.closed && revision === this.revision && this.deps.isCurrent();
  }

  private assertCurrent(revision: number): void {
    if (!this.isCurrent(revision)) throw new DOMException("Conversation naming was cancelled or superseded", "AbortError");
  }
}

function completedExchanges(messages: readonly TitleMessage[]): number {
  let pendingUser = false;
  let exchanges = 0;
  for (const message of messages) {
    if (message.role === "user") pendingUser = true;
    else if (pendingUser) { exchanges++; pendingUser = false; }
  }
  return exchanges;
}
