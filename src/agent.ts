import {
  type AgentContext,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type McpServer,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import {
  type CanUseToolContext,
  type CanUseToolResponse,
  LettaAgentClient,
  type LettaCodeSession,
  type LettaConversation,
  type McpServers,
  type MessageContentItem,
  type PermissionMode,
  type ReasoningEffort,
  type SDKMessage,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { authMethodsForClient } from "./auth.js";
import { DEFAULT_ACP_MODEL, type LettaAcpConfig } from "./config.js";
import { debug } from "./debug.js";
import {
  createEditorTools,
  type EditorFsCapabilities,
} from "./editor-tools.js";
import { historyToUpdates } from "./history-replay.js";
import {
  collapseVariants,
  groupedModelOptions,
  isUsableModel,
  variantOf,
} from "./model-options.js";
import { planEntriesFrom, UPDATE_PLAN_TOOL } from "./plan.js";
import { withAcpRequestTimeout } from "./request-timeout.js";
import { SessionRegistry } from "./session-registry.js";
import { type PromptEvents, SessionReader } from "./session-reader.js";
import {
  editorReadAutoAllows,
  isSessionModeId,
  modeAutoAllows,
  PERMISSION_MODE_CONFIG_ID,
  permissionModeConfigOption,
  sessionModeState,
} from "./session-modes.js";
import {
  entryReasoningEffort,
  THOUGHT_LEVEL_CONFIG_ID,
  thoughtLevelConfigOption,
} from "./thought-level.js";
import {
  buildAvailableCommands,
  isExecuteCommand,
} from "./slash-commands.js";
import {
  accumulateToolInput,
  isTerminalOutputTool,
  parseToolOutput,
  type ToolCallInputState,
  toolDiffContent,
  toolKind,
  toolLocations,
  toolOutputLine,
  toolResultContent,
  toolTitle,
} from "./tool-info.js";

interface StreamedToolCall {
  /** First non-placeholder name seen for this tool call. */
  toolName: string;
  input: ToolCallInputState;
  /** Whether the ACP card already contains a native diff. */
  hasDiff: boolean;
  /** Whether terminal_info has created a native terminal for this call. */
  hasTerminal: boolean;
}

interface AcpSessionState {
  session: LettaCodeSession;
  /** Connection-scoped ACP client context used for requests and notifications. */
  clientContext: AgentContext;
  /** Most recent tool_call streamed, to correlate permission requests. */
  lastToolCall: { id: string; name: string } | null;
  /** Tool calls still streaming or running, keyed by tool call id. */
  toolCalls: Map<string, StreamedToolCall>;
  /** Tools the user chose "always allow" for, scoped to this session. */
  alwaysAllowed: Set<string>;
  cancelled: boolean;
  /** True only while a session/prompt handler is running. */
  promptActive: boolean;
  /** ACP session mode; enforced adapter-side in the permission callback. */
  modeId: PermissionMode;
  /** Session working directory (for project skill discovery). */
  cwd: string;
  /** Runtime model handle, or selected catalog id (preserves context variants). */
  currentModel: string | undefined;
  /** Reasoning tier selected over ACP; validated against the model catalog. */
  reasoningEffort: string | undefined;
  /** Reuse only when runtime-bound cwd, MCP servers and editor tools match. */
  runtimeConfigKey: string;
  reader: SessionReader | null;
  promptEvents: PromptEvents | null;
  /** Cached model catalog, shared by every config request in its TTL window. */
  modelCatalog?: {
    expiresAt: number;
    promise: Promise<Awaited<ReturnType<LettaCodeSession["listModels"]>>["entries"]>;
  };
}

/** Max history messages replayed on session/load. */
const LOAD_HISTORY_LIMIT = 200;
/** Number of project sessions returned in one session/list page. */
const SESSION_LIST_PAGE_SIZE = 50;
/** Coalesce Zed's load/config restoration requests without hiding changes indefinitely. */
const MODEL_CATALOG_TTL_MS = 30_000;

/**
 * Liveness bound for permission requests raised outside a prompt turn.
 *
 * ACP scopes `session/request_permission` to a turn: the client's only
 * obligation to answer is the `session/cancel` contract, which no longer
 * applies once the prompt handler has returned. A client with no out-of-turn
 * permission UI would leave the Letta-side tool call pending forever, so those
 * requests get a generous-but-finite deadline. In-turn requests stay unbounded.
 */
const DEFAULT_OUT_OF_TURN_PERMISSION_TIMEOUT_MS = 300_000;

/**
 * Wait for continuation after an unconfirmed completion, including synthetic
 * results without turn activity. Metadata chatter must not extend this bound.
 */
const DEFAULT_PREMATURE_RESULT_GRACE_MS = 30_000;

/** Safety cap on stream rounds while waiting for a slash command to finish. */
const EXECUTE_COMMAND_MAX_ROUNDS = 50;

type PumpOutcome =
  | { kind: "result"; result: SDKResultMessage }
  /** A prior-run or synthetic result cannot confirm this prompt's completion. */
  | { kind: "premature"; result: SDKResultMessage }
  | { kind: "idle" }
  /** Stream ended; carries what the round last saw for active runs. */
  | { kind: "stream_end"; activeRunIds: readonly string[]; sawActivity: boolean };

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Bridges ACP v1 (agent side) onto a Letta agent via the Letta Agent SDK.
 *
 * One process serves one ACP connection. Every ACP session becomes a new
 * Letta conversation on a single underlying Letta agent, so the agent's
 * memory persists across sessions and editors.
 */
export class LettaAcpAgent {
  private readonly config: LettaAcpConfig;
  private readonly client: LettaAgentClient;
  private readonly outOfTurnPermissionTimeoutMs: number;
  private readonly prematureResultGraceMs: number;
  /** 0 disables staying with runs whose stream ended while still listed. */
  private readonly activeRunSilenceMs: number;
  private readonly sessionRegistry: SessionRegistry;
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly sessionLoads = new Map<string, Promise<LoadSessionResponse>>();
  private readonly commandAnnouncements = new Set<ReturnType<typeof setImmediate>>();
  private agentIdPromise: Promise<string> | null = null;
  private supportsTerminalOutput = false;
  private clientFsCaps: EditorFsCapabilities = {
    readTextFile: false,
    writeTextFile: false,
  };

  constructor(config: LettaAcpConfig) {
    this.config = config;
    this.client = new LettaAgentClient(config.clientOptions);
    this.sessionRegistry = new SessionRegistry(
      config.sessionRegistryDir ?? null,
      config.sessionRegistryScope ?? config.clientOptions.backend ?? "local",
    );
    this.outOfTurnPermissionTimeoutMs =
      config.outOfTurnPermissionTimeoutMs ??
      DEFAULT_OUT_OF_TURN_PERMISSION_TIMEOUT_MS;
    this.prematureResultGraceMs =
      config.prematureResultGraceMs ?? DEFAULT_PREMATURE_RESULT_GRACE_MS;
    this.activeRunSilenceMs = config.activeRunSilenceMs ?? 0;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    debug({ ev: "initialize", backend: this.config.clientOptions.backend ?? "local" });
    const fs = params.clientCapabilities?.fs;
    this.supportsTerminalOutput =
      params.clientCapabilities?._meta?.terminal_output === true;
    this.clientFsCaps = {
      readTextFile: fs?.readTextFile === true,
      writeTextFile: fs?.writeTextFile === true,
    };
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === "number" && requested < PROTOCOL_VERSION
        ? requested
        : PROTOCOL_VERSION;
    return {
      protocolVersion,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {} },
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: authMethodsForClient(
        params.clientCapabilities,
        this.config.clientOptions.backend === "local",
      ),
    };
  }

  async newSession(
    params: NewSessionRequest,
    cx: AgentContext,
  ): Promise<NewSessionResponse> {
    const started = performance.now();
    const agentId = await timed("ensure agent", () => this.ensureAgent());
    const { sessionId, state } = await this.openSession({
      cwd: params.cwd,
      resumeId: null,
      agentId,
      clientContext: cx,
      mcpServers: params.mcpServers,
    });
    await this.rememberSession(agentId, sessionId, params.cwd);
    log(`session ${sessionId} -> agent ${agentId} (cwd: ${params.cwd})`);
    const configOptions = await this.sessionConfigOptions(state);
    this.startReader(sessionId, state);
    log(`timing: new session ${Math.round(performance.now() - started)}ms`);
    // The SDK queues the response in a promise continuation. Wait until the
    // next event-loop turn so Zed registers the id before receiving commands.
    const announcement = setImmediate(() => {
      this.commandAnnouncements.delete(announcement);
      if (this.sessions.has(sessionId)) this.announceCommands(sessionId, cx);
    });
    this.commandAnnouncements.add(announcement);
    return {
      sessionId,
      modes: sessionModeState(state.modeId),
      configOptions,
    };
  }

  async loadSession(
    params: LoadSessionRequest,
    cx: AgentContext,
  ): Promise<LoadSessionResponse> {
    // Keep concurrent loads from opening duplicate runtimes or interleaving replay.
    // A failed load must not prevent the next queued load from retrying.
    const previous = this.sessionLoads.get(params.sessionId);
    const pending = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.loadSessionOnce(params, cx));
    const tracked = pending.finally(() => {
      if (this.sessionLoads.get(params.sessionId) === tracked) {
        this.sessionLoads.delete(params.sessionId);
      }
    });
    this.sessionLoads.set(params.sessionId, tracked);
    return tracked;
  }

  private async loadSessionOnce(
    params: LoadSessionRequest,
    cx: AgentContext,
  ): Promise<LoadSessionResponse> {
    const started = performance.now();
    if (
      !params.sessionId.startsWith("conv-") &&
      !params.sessionId.startsWith("local-conv-")
    ) {
      throw new Error(
        `Cannot load session ${params.sessionId}: not a Letta conversation id`,
      );
    }
    const { sessionId, state } = await this.openSession({
      cwd: params.cwd,
      resumeId: params.sessionId,
      agentId: null,
      clientContext: cx,
      mcpServers: params.mcpServers,
    });
    await this.rememberSession(state.session.agentId, sessionId, params.cwd);
    const history = await timed("load history", () =>
      state.session.listMessages({ order: "desc", limit: LOAD_HISTORY_LIMIT }),
    );
    if (history.hasMore) {
      log(
        `session ${sessionId} has more than ${LOAD_HISTORY_LIMIT} messages; replaying the most recent ${LOAD_HISTORY_LIMIT}`,
      );
    }
    const updates = historyToUpdates([...history.messages].reverse(), {
      terminalOutput: this.supportsTerminalOutput,
      cwd: state.cwd,
    });
    await timed("replay history", async () => {
      for (const update of updates) {
        await cx.notify(methods.client.session.update, { sessionId, update });
      }
    });
    log(`loaded session ${sessionId} (${updates.length} replayed updates)`);
    this.announceCommands(sessionId, cx);
    const configOptions = await this.sessionConfigOptions(state);
    this.startReader(sessionId, state);
    log(`timing: load session ${Math.round(performance.now() - started)}ms`);
    return {
      modes: sessionModeState(state.modeId),
      configOptions,
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const agentId = await this.ensureAgent();
    const records = await this.sessionRegistry.list(agentId, params.cwd);
    if (records.length === 0) return { sessions: [] };

    let start = 0;
    if (params.cursor) {
      const previous = records.findIndex((record) => record.sessionId === params.cursor);
      if (previous < 0) throw new Error("Invalid session/list cursor");
      start = previous + 1;
    }

    // Bound each page by registry records rather than successful lookups. Stale
    // or temporarily unavailable conversations must not turn one list request
    // into an unbounded sequence of management calls.
    const page = records.slice(start, start + SESSION_LIST_PAGE_SIZE);
    const resolved = await Promise.all(
      page.map(async (record) => {
        let conversation: LettaConversation;
        try {
          conversation = await this.client.conversations.retrieve(record.sessionId);
        } catch (error) {
          // A deleted conversation is indistinguishable here from a transient
          // management failure. Omit it for this response but retain the local
          // record so an outage cannot erase discoverability permanently.
          log(`cannot resolve listed session ${record.sessionId}: ${String(error)}`);
          return null;
        }
        if (conversation.agent_id !== agentId || conversation.archived === true) {
          await this.sessionRegistry.remove(record.sessionId);
          return null;
        }
        const title = sessionTitle(conversation);
        const updatedAt =
          conversation.last_message_at ??
          conversation.updated_at ??
          conversation.created_at ??
          record.recordedAt;
        return {
          sessionId: record.sessionId,
          cwd: record.cwd,
          ...(title ? { title } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
      }),
    );
    const sessions = resolved.filter(
      (session): session is NonNullable<typeof session> => session !== null,
    );
    const last = page.at(-1);

    return {
      sessions,
      ...(last && start + page.length < records.length
        ? { nextCursor: last.sessionId }
        : {}),
    };
  }

  private async rememberSession(
    agentId: string | null | undefined,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    if (!agentId) {
      log(`cannot record session ${sessionId}: runtime did not report an agent id`);
      return;
    }
    try {
      await this.sessionRegistry.record(agentId, sessionId, cwd);
    } catch (error) {
      // Session creation/loading already succeeded. Do not turn a local metadata
      // write failure into a retry that creates a duplicate conversation.
      log(`failed to record session ${sessionId}: ${String(error)}`);
    }
  }

  /**
   * Provider names the runtime reports as connected, or null when it cannot say.
   *
   * Asked over the runtime's own protocol rather than a Cloud-only endpoint so
   * local and self-hosted backends filter identically. A failed or empty answer
   * is treated as "unknown" — the caller then leaves the model list unfiltered
   * rather than hide models it cannot confirm are unusable.
   */
  private async connectedProviderNames(
    session: LettaCodeSession,
  ): Promise<Set<string> | null> {
    try {
      const response = await session.sendCommand(
        { type: "list_connect_providers", target: "local" },
        { responseType: "list_connect_providers_response", timeoutMs: 5_000 },
      );
      const providers = (response as { providers?: unknown }).providers;
      if (!Array.isArray(providers)) return null;
      const names = new Set<string>();
      for (const raw of providers) {
        const entry = raw as {
          provider_names?: unknown;
          connected?: { is_connected?: unknown; provider_name?: unknown };
          connected_providers?: Array<{
            is_connected?: unknown;
            provider_name?: unknown;
          }>;
        };
        const states = [
          ...(entry.connected ? [entry.connected] : []),
          ...(Array.isArray(entry.connected_providers)
            ? entry.connected_providers
            : []),
        ];
        if (!states.some((state) => state?.is_connected === true)) continue;
        for (const state of states) {
          if (typeof state?.provider_name === "string") {
            names.add(state.provider_name);
          }
        }
        if (Array.isArray(entry.provider_names)) {
          for (const name of entry.provider_names) {
            if (typeof name === "string") names.add(name);
          }
        }
      }
      return names.size > 0 ? names : null;
    } catch (error) {
      log(`could not list connected providers: ${String(error)}`);
      return null;
    }
  }

  /**
   * Zed fires several config requests back to back when it restores a session,
   * and discovery asks the runtime for its catalog and then for connected
   * providers each time. Share one in-flight discovery across all callers and
   * keep the result for a short window. A window rather than a permanent cache
   * keeps a newly connected provider visible without restarting the adapter.
   */
  private async sessionModels(state: AcpSessionState) {
    if (state.modelCatalog && performance.now() < state.modelCatalog.expiresAt) {
      return state.modelCatalog.promise;
    }
    const cached = {
      expiresAt: Infinity,
      promise: timed("model discovery", async () => {
        const [{ entries }, connected] = await Promise.all([
          timed("model catalog", () => state.session.listModels()),
          timed("connected providers", () => this.connectedProviderNames(state.session)),
        ]);
        const catalog = [
          ...new Map(entries.map((entry) => [entry.id, entry])).values(),
        ];
        // Unknown provider state retains the full catalog rather than hiding models.
        const models = connected
          ? catalog.filter((entry) => isUsableModel(entry, connected))
          : catalog;
        if (connected) {
          log(
            `models: ${models.length}/${catalog.length} usable ` +
              `(${connected.size} connected providers: ${[...connected].sort().join(", ")})`,
          );
        }
        return models;
      }),
    };
    state.modelCatalog = cached;
    try {
      const models = await cached.promise;
      cached.expiresAt = performance.now() + MODEL_CATALOG_TTL_MS;
      return models;
    } catch (error) {
      if (state.modelCatalog === cached) state.modelCatalog = undefined;
      throw error;
    }
  }

  private async sessionConfigOptions(
    state: AcpSessionState,
  ): Promise<SessionConfigOption[]> {
    const models = await this.sessionModels(state);

    // Collapse each model variant to one row and group rows by provider. Reasoning
    // tiers are separate catalog entries, but the tier is picked through the
    // thought-level option, so the picker must not repeat the model per tier.
    const variants = collapseVariants(models);
    const active =
      models.find((entry) => entry.id === state.currentModel) ??
      models.find((entry) => entry.handle === state.currentModel);
    let currentValue = active
      ? (variantOf(active, variants)?.id ?? active.id)
      : (variants.find((entry) => entry.isDefault)?.id ?? variants[0]?.id);
    const options = groupedModelOptions(variants);

    // A custom model handle may be active even when it is not in the curated
    // catalog. ACP requires currentValue to identify one of the options, so
    // retain that model rather than falsely presenting a different selection.
    if (!active && state.currentModel) {
      currentValue = state.currentModel;
      options.unshift({
        group: "custom",
        name: "Custom",
        options: [{ value: state.currentModel, name: state.currentModel }],
      });
    }
    const configOptions: SessionConfigOption[] = [
      permissionModeConfigOption(state.modeId),
    ];
    if (currentValue) {
      configOptions.push({
        id: "model",
        name: "Model",
        description: "Model used for this Letta session",
        category: "model",
        type: "select",
        currentValue,
        options,
      });
    }
    // Reasoning tiers are catalog entries that share a handle, so derive them
    // from the catalog. A custom handle outside it has no tiers, hence no option.
    const thoughtLevel = thoughtLevelConfigOption(
      models,
      active?.handle ?? state.currentModel,
      state.reasoningEffort ??
        (active ? entryReasoningEffort(active) : undefined),
    );
    if (thoughtLevel) {
      configOptions.push(thoughtLevel);
    }
    return configOptions;
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const started = performance.now();
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (params.configId === PERMISSION_MODE_CONFIG_ID) {
      if (typeof params.value !== "string" || !isSessionModeId(params.value)) {
        throw new Error(`Unknown permission mode: ${String(params.value)}`);
      }
      state.modeId = params.value;
      log(`session ${params.sessionId} mode -> ${params.value}`);
      const result = { configOptions: await this.sessionConfigOptions(state) };
      log(`timing: set session config ${params.configId} ${Math.round(performance.now() - started)}ms`);
      return result;
    }
    if (params.configId === "model") {
      if (typeof params.value !== "string") {
        throw new Error("The model configuration option requires a model id");
      }
      const optionsStarted = performance.now();
      const configOptions = await this.sessionConfigOptions(state);
      const optionsMs = Math.round(performance.now() - optionsStarted);
      const selected = configOptions.find((option) => option.id === "model");
      const models = await this.sessionModels(state);
      // A handle alone cannot confirm which context-window variant is active.
      // Only suppress restoration when the selection is known, not inferred.
      const selectionKnown = models.some((entry) => entry.id === state.currentModel) ||
        collapseVariants(models).filter((entry) => entry.handle === state.currentModel).length === 1;
      if (
        selectionKnown &&
        (params.value === state.currentModel || params.value === selected?.currentValue)
      ) {
        log(
          `timing: set session config ${params.configId} ${Math.round(performance.now() - started)}ms ` +
            `(options ${optionsMs}, no update)`,
        );
        return { configOptions };
      }
      const updateStarted = performance.now();
      const result = await state.session.updateModel(params.value);
      // Commit the successful mutation before any later discovery can fail.
      state.currentModel = models.some((entry) => entry.id === params.value)
        ? params.value
        : result.modelHandle ?? result.modelId ?? params.value;
      // A new model may not offer the previous tier; let the catalog decide.
      const updateMs = Math.round(performance.now() - updateStarted);
      const rebuildStarted = performance.now();
      const rebuilt = await this.sessionConfigOptions(state);
      const rebuildMs = Math.round(performance.now() - rebuildStarted);
      state.reasoningEffort = undefined;
      log(`session ${params.sessionId} model -> ${state.currentModel}`);
      log(
        `timing: set session config ${params.configId} ${Math.round(performance.now() - started)}ms ` +
          `(options ${optionsMs}, updateModel ${updateMs}, rebuild ${rebuildMs})`,
      );
      return { configOptions: rebuilt };
    }
    if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (typeof params.value !== "string") {
        throw new Error("The thought level configuration option requires a tier");
      }
      // Reasoning-only update: keeps the model and its other settings. The SDK
      // rejects tiers the target handle does not advertise.
      const levelStarted = performance.now();
      await state.session.updateModel({
        reasoningEffort: params.value as ReasoningEffort,
      });
      state.reasoningEffort = params.value;
      const rebuilt = await this.sessionConfigOptions(state);
      log(`session ${params.sessionId} thought level -> ${params.value}`);
      log(
        `timing: set session config ${params.configId} ${Math.round(performance.now() - started)}ms ` +
          `(update+rebuild ${Math.round(performance.now() - levelStarted)})`,
      );
      return { configOptions: rebuilt };
    }
    throw new Error(`Unknown session configuration option: ${params.configId}`);
  }

  async setSessionMode(
    params: SetSessionModeRequest,
    cx: AgentContext,
  ): Promise<SetSessionModeResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (!isSessionModeId(params.modeId)) {
      throw new Error(`Unknown mode: ${params.modeId}`);
    }
    state.modeId = params.modeId;
    log(`session ${params.sessionId} mode -> ${params.modeId}`);
    void cx.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      },
    });
    return {};
  }

  /**
   * Creates or resumes the underlying Letta session and registers state.
   *
   * The ACP session id is the Letta conversation id, which is what makes
   * session/load work across adapter restarts with no local persistence. The
   * id is only known after the runtime initializes, so callbacks close over a
   * mutable ref that is filled in before any of them can fire (they only run
   * during prompts).
   *
   * The harness always runs with permissionMode "standard"; the ACP-selected
   * mode is enforced adapter-side (see session-modes.ts).
   */
  private async openSession(options: {
    cwd: string;
    resumeId: string | null;
    agentId: string | null;
    clientContext: AgentContext;
    mcpServers?: readonly McpServer[];
  }): Promise<{ sessionId: string; state: AcpSessionState }> {
    const runtimeConfigKey = JSON.stringify([
      options.cwd,
      toSdkMcpServers(options.mcpServers),
      this.clientFsCaps,
    ]);
    const existing = options.resumeId
      ? this.sessions.get(options.resumeId)
      : undefined;
    if (existing?.promptActive) {
      throw new Error(`Cannot load session ${options.resumeId} during an active prompt`);
    }
    if (existing?.runtimeConfigKey === runtimeConfigKey) {
      try {
        const ready = await timed("reuse runtime", () => existing.session.ready());
        existing.clientContext = options.clientContext;
        return { sessionId: ready.conversationId, state: existing };
      } catch (error) {
        log(`reopening unavailable session ${options.resumeId}: ${String(error)}`);
        existing.reader?.stop();
        existing.session.close();
      }
    }
    const ref = { sessionId: options.resumeId ?? "" };
    const editorTools = createEditorTools(this.clientFsCaps, {
      getSessionId: () => ref.sessionId,
      getClientContext: () =>
        this.sessions.get(ref.sessionId)?.clientContext ?? null,
    });
    const mcpServers = toSdkMcpServers(options.mcpServers);
    const sessionOptions = {
      cwd: options.cwd,
      model: this.config.model,
      permissionMode: "standard" as const,
      canUseTool: (
        toolName: string,
        toolInput: Record<string, unknown>,
        context?: CanUseToolContext,
      ) =>
        this.requestToolPermission(
          ref.sessionId,
          toolName,
          toolInput,
          context,
        ),
      ...(editorTools.length > 0 ? { tools: editorTools } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };
    const session = options.resumeId
      ? this.client.resumeSession(options.resumeId, sessionOptions)
      : this.client.createSession(options.agentId ?? "", sessionOptions);
    // ready() initializes the runtime without fetching a redundant history page.
    const bootstrap = await timed("initialize runtime", async () => {
      try {
        return await session.ready();
      } catch (error) {
        session.close();
        throw error;
      }
    });
    const sessionId = options.resumeId ?? session.conversationId;
    if (!sessionId) {
      session.close();
      throw new Error("Letta session did not report a conversation id");
    }
    ref.sessionId = sessionId;
    if (editorTools.length > 0) {
      log(
        `editor fs tools enabled: ${editorTools.map((tool) => tool.name).join(", ")}`,
      );
    }
    const state: AcpSessionState = {
      session,
      clientContext: options.clientContext,
      lastToolCall: null,
      toolCalls: new Map(),
      alwaysAllowed: new Set(),
      cancelled: false,
      promptActive: false,
      modeId: this.config.permissionMode,
      cwd: options.cwd,
      currentModel: bootstrap.model ?? this.config.model,
      reasoningEffort: undefined,
      runtimeConfigKey,
      reader: null,
      promptEvents: null,
    };
    // A client may load the same conversation again while its prior ACP
    // session is still open. Close the displaced SDK session before replacing
    // it so its sockets and per-session MCP subprocesses are not orphaned.
    const displaced = this.sessions.get(sessionId);
    if (displaced && displaced.session !== session) {
      displaced.reader?.stop();
      displaced.session.close();
    }
    this.sessions.set(sessionId, state);
    return { sessionId, state };
  }

  private startReader(sessionId: string, state: AcpSessionState): SessionReader {
    if (!state.reader) debug({ ev: "reader_start", sessionId });
    state.reader ??= new SessionReader(
      state.session,
      (message) => this.forwardMessage(sessionId, state, message, state.clientContext),
      (error) => log(`session reader failed for ${sessionId}: ${String(error)}`),
    );
    return state.reader;
  }

  private announceCommands(sessionId: string, cx: AgentContext): void {
    const cwd = this.sessions.get(sessionId)?.cwd ?? process.cwd();
    const availableCommands = buildAvailableCommands(cwd);
    log(`advertising ${availableCommands.length} slash commands`);
    void cx.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    }).catch((error) => log(`command announcement failed for ${sessionId}: ${String(error)}`));
  }

  async prompt(
    params: PromptRequest,
    cx: AgentContext,
  ): Promise<PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (this.sessionLoads.has(params.sessionId)) {
      throw new Error(`Cannot prompt session ${params.sessionId} while it is loading`);
    }
    if (state.promptActive) throw new Error(`Session ${params.sessionId} already has an active prompt`);
    const reader = this.startReader(params.sessionId, state);
    const events = reader.observe();
    state.promptEvents = events;
    state.clientContext = cx;
    state.cancelled = false;
    state.promptActive = true;

    try {
      const commandResponse = await this.maybeRunCommand(params, state, cx);
      if (commandResponse) return commandResponse;
      await state.session.send(toLettaContent(params.prompt));
      // The Letta app-server transport completes a turn with a recoverable
      // "approval_conflict" result whenever a tool needs user approval. The
      // approval itself resolves concurrently: the server sends a
      // can_use_tool control request, our canUseTool callback forwards it to
      // the ACP client, and once answered the run resumes and its events keep
      // streaming — but with no second terminal result message. So: pump the
      // first round to its result, then pump recovery rounds (blocking on the
      // stream while approvals resolve) until the run goes idle.
      let mode: "turn" | "recovery" = "turn";
      let graceMs: number | undefined;
      let pendingRunIds: readonly string[] = [];
      let unconfirmedDeadline: number | undefined;
      let round = 0;
      while (true) {
        round += 1;
        const outcome = await this.pumpStream(
          params.sessionId,
          state,
          mode,
          graceMs,
        );
        // The round's outcome is the one fact the byte stream cannot show: the
        // client only sees the notifications that came out of it, so a turn
        // that ends early and a turn whose work never arrived look identical.
        // Record what the pump decided and on what evidence, before acting on it.
        debug({
          ev: "round",
          sessionId: params.sessionId,
          round,
          mode,
          graceMs: graceMs ?? null,
          outcome: outcome.kind,
          sawActivity: events.hasActivity,
          ...(outcome.kind === "premature" || outcome.kind === "result"
            ? {
                success: outcome.result.success,
                stopReason: outcome.result.stopReason ?? null,
                errorCode: outcome.result.errorCode ?? null,
                runIds: outcome.result.runIds ?? [],
              }
            : {}),
          ...(outcome.kind === "stream_end"
            ? {
                activeRunIds: outcome.activeRunIds,
                sawActivity: outcome.sawActivity,
              }
            : {}),
        });
        if (state.cancelled) return { stopReason: "cancelled" };
        switch (outcome.kind) {
          case "premature": {
            // The SDK ends its stream on any result, so the only way to stay
            // with the run is another round — the same recovery the
            // approval_conflict path uses, but on a deadline in case the
            // server really was done.
            pendingRunIds = outcome.result.runIds ?? [];
            const runIds = pendingRunIds.join(", ") || "unknown";
            log(`turn completion is unconfirmed (runs: ${runIds}); waiting for continuation`);
            mode = "recovery";
            if (!events.hasActivity) {
              unconfirmedDeadline ??= performance.now() + this.prematureResultGraceMs;
              graceMs = Math.max(0, unconfirmedDeadline - performance.now());
            } else {
              graceMs = this.prematureResultGraceMs;
            }
            continue;
          }
          case "result": {
            const result = outcome.result;
            if (!result.success && result.errorCode === "approval_conflict") {
              mode = "recovery";
              graceMs = undefined;
              continue;
            }
            return this.toPromptResponse(state, result);
          }
          case "idle":
            if (!events.hasActivity) {
              throw new Error("Letta reported idle without confirming completion of this prompt; no turn activity followed");
            }
            // Release the prompt after the grace window; the session reader
            // still delivers later work without another user message.
            return { stopReason: "end_turn" };
          case "stream_end": {
            if (!events.hasActivity) {
              throw new Error("Letta stream ended without confirming completion of this prompt");
            }
            // Preserve the existing grace policy for a stream ending while the
            // server still lists active runs. Delivery no longer depends on it.
            // When enabled, stay with the run; the round's first-message deadline
            // becomes the silence window, and a round that says nothing still ends
            // the turn, so a stale run cannot hold it open indefinitely.
            const stillActive =
              outcome.activeRunIds.length > 0
                ? outcome.activeRunIds
                : pendingRunIds;
            if (
              this.activeRunSilenceMs > 0 &&
              outcome.sawActivity &&
              stillActive.length > 0
            ) {
              log(
                `stream ended while runs are still active ` +
                  `(${stillActive.join(", ")}); staying up to ${this.activeRunSilenceMs}ms`,
              );
              pendingRunIds = stillActive;
              mode = "recovery";
              graceMs = this.activeRunSilenceMs;
              continue;
            }
            return { stopReason: "end_turn" };
          }
        }
      }
    } catch (error) {
      if (state.cancelled) return { stopReason: "cancelled" };
      throw error;
    } finally {
      reader.release(events);
      state.promptEvents = null;
      // Delivery outlives this observer; late permissions use a finite deadline.
      state.promptActive = false;
    }
  }

  /**
   * Handles slash commands that have a non-LLM implementation: /model runs in
   * the adapter, and execute_command-backed commands run in the harness.
   * Returns null for everything else — unknown /names fall through as prompt
   * text, which is how skill invocations reach the model.
   */
  private async maybeRunCommand(
    params: PromptRequest,
    state: AcpSessionState,
    cx: AgentContext,
  ): Promise<PromptResponse | null> {
    const first = params.prompt[0];
    if (params.prompt.length !== 1 || first?.type !== "text") return null;
    const match = first.text.trim().match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const command = (match[1] ?? "").toLowerCase();
    const argument = match[2]?.trim();

    if (isExecuteCommand(command)) {
      return this.runExecuteCommand(params.sessionId, state, cx, command, argument);
    }
    if (command !== "model") return null;

    const reply = async (text: string) => {
      await cx.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    };
    try {
      if (!argument) {
        const result = await state.session.listModels();
        const lines = result.entries.map((model) => {
          const marks = [
            model.isDefault ? "default" : null,
            model.free ? "free" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return `- \`${model.handle}\` — ${model.label}${marks ? ` (${marks})` : ""}`;
        });
        await reply(
          `Available models:\n${lines.join("\n")}\n\nSwitch with \`/model <handle>\`.`,
        );
      } else {
        const result = await state.session.updateModel(argument);
        state.currentModel = result.modelHandle ?? result.modelId ?? argument;
        await reply(`Model switched to \`${state.currentModel}\`.`);
      }
    } catch (error) {
      await reply(
        `/model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { stopReason: "end_turn" };
  }

  /**
   * Dispatches a slash command to the harness via the app-server protocol's
   * execute_command, forwarding any resulting agent-turn events (e.g. /init
   * and /remember run full turns) and finishing on the slash_command_end
   * stream delta that carries the command's output.
   */
  private async runExecuteCommand(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    command: string,
    argument: string | undefined,
  ): Promise<PromptResponse> {
    log(`executing /${command} via execute_command`);
    await state.session.sendCommand({
      type: "execute_command",
      command_id: command,
      request_id: `acp-${crypto.randomUUID()}`,
      runtime: {
        agent_id: state.session.agentId,
        conversation_id: state.session.conversationId,
      },
      ...(argument ? { args: argument } : {}),
    });

    for (let round = 0; round < EXECUTE_COMMAND_MAX_ROUNDS; round++) {
      // A cancel can land between nested command results.
      if (state.cancelled) return { stopReason: "cancelled" };
      while (true) {
        const event = await state.promptEvents!.next();
        if (!event || !event.message) {
          if (event?.error) throw event.error;
          throw new Error(`/${command} stream closed before completion`);
        }
        const message = event.message;
        if (state.cancelled) return { stopReason: "cancelled" };
        if (message.type === "stream_event") {
          const event = message.event as Record<string, unknown>;
          if (
            event.message_type === "slash_command_end" &&
            event.command_id === command
          ) {
            const output = typeof event.output === "string" ? event.output : "";
            const success = event.success !== false;
            if (output) {
              await cx.notify(methods.client.session.update, {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: success ? output : `/${command} failed: ${output}`,
                  },
                },
              });
            }
            return { stopReason: "end_turn" };
          }
          continue;
        }
        if (message.type === "result") {
          // Commands like /init and /remember run a full agent turn. A
          // successful nested result, or a recoverable approval conflict,
          // ends this SDK stream round but not the command: its continuation
          // and slash_command_end arrive through a subsequent stream().
          if (
            message.success ||
            message.errorCode === "approval_conflict"
          ) {
            break;
          }
          // Do not turn genuine nested-turn failures into 50 opaque recovery
          // rounds followed by "/<command> did not complete".
          return this.toPromptResponse(state, message);
        }
      }
    }
    throw new Error(`/${command} did not complete`);
  }

  /**
   * Observes one turn round after the session reader delivers its events.
   * In "recovery" mode (post-approval continuation) there is no terminal
   * result message, so loop_status transitions decide when the turn is over.
   * Blocking on the stream while an approval is pending is fine — the
   * canUseTool round-trip resolves concurrently over the control channel.
   */
  private async pumpStream(
    sessionId: string,
    state: AcpSessionState,
    mode: "turn" | "recovery",
    firstMessageDeadlineMs?: number,
  ): Promise<PumpOutcome> {
    let sawActivity = false;
    let sawProtocolActivity = false;
    let idleStatusCount = 0;
    let activeRunIds: readonly string[] = [];
    const startedAt = performance.now();
    // Record prompt coordination separately from session-wide delivery.
    debug({
      ev: "round_start",
      sessionId,
      mode,
      deadlineMs: firstMessageDeadlineMs ?? null,
    });

    let awaitingActivity = true;
    const deadline = firstMessageDeadlineMs === undefined
      ? undefined : startedAt + firstMessageDeadlineMs;
    while (true) {
      if (awaitingActivity && deadline !== undefined && performance.now() >= deadline) {
        return { kind: "idle" };
      }
      // Expiring this observation must not leave a pending SDK read behind.
      const step = await state.promptEvents!.next(
        awaitingActivity && deadline !== undefined
          ? Math.max(0, deadline - performance.now()) : undefined,
      );
      if (!step) {
        debug({
          ev: "round_deadline",
          sessionId,
          mode,
          waitedMs: firstMessageDeadlineMs,
          sawActivity,
          activeRunIds,
        });
        log("no turn activity before the recovery deadline");
        return { kind: "idle" };
      }
      if (!step.message) {
        if (step.error) throw step.error;
        break;
      }
      const message = step.message;
      if (step.stale) {
        if (message.type === "result") {
          debug({ ev: "ignored_prior_result", sessionId, runIds: message.runIds ?? [] });
          return { kind: "premature", result: message };
        }
        continue;
      }
      if (step.forwarded) awaitingActivity = false;
      if (message.type !== "init" && message.type !== "queue_update" && message.type !== "loop_status") {
        sawProtocolActivity = true;
      }

      if (message.type === "result") {
        // The SDK can synthesize success from user/metadata deltas plus idle,
        // with neither a terminal reason nor model activity. It can also do so
        // while runs remain active. Neither proves this prompt finished.
        if (
          message.success &&
          message.stopReason == null &&
          (activeRunIds.length > 0 || !state.promptEvents!.hasActivity)
        ) {
          return { kind: "premature", result: message };
        }
        return { kind: "result", result: message };
      }
      if (message.type === "loop_status") {
        activeRunIds = message.activeRunIds;
        // Metadata is also SDK turn evidence: drain its interrupted result,
        // even when nothing was rendered. In recovery the SDK already consumed
        // its tracker, so idle has no second result to wait for.
        if (message.status === "WAITING_ON_INPUT" && state.cancelled) {
          if (mode === "turn" && sawProtocolActivity) continue;
          return { kind: "idle" };
        }
        if (mode === "recovery") {
          if (message.status === "WAITING_ON_INPUT") {
            idleStatusCount += 1;
            // The first idle status can be queued before the resume; repetitions
            // are useful only after this prompt did real work.
            if (sawActivity || (idleStatusCount >= 2 && state.promptEvents!.hasActivity)) {
              return { kind: "idle" };
            }
          }
          continue;
        }
      }
      sawActivity = sawActivity || step.forwarded;
    }
    debug({
      ev: "round_end",
      sessionId,
      mode,
      elapsedMs: Math.round(performance.now() - startedAt),
      sawActivity,
      activeRunIds,
    });
    if (mode === "recovery" && !sawActivity) {
      // The fork's silence window only re-arms a still-working run when the
      // round produced activity, so an active run voice:false during one is a
      // stale listing rather than work in progress — and it is also the exact
      // case where a resolved turn strands late output out-of-turn.
      debug({
        ev: "round_silent",
        sessionId,
        activeRunIds,
        note: "active runs listed but the round produced nothing",
      });
    }
    return { kind: "stream_end", activeRunIds, sawActivity };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return;
    state.cancelled = true;
    // Interrupted tool calls never produce a tool_result, so drop their
    // accumulated arguments here instead of leaking them for the session.
    state.toolCalls.clear();
    try {
      await state.session.abort();
    } catch (error) {
      log(`abort failed for ${params.sessionId}: ${String(error)}`);
    }
  }

  shutdown(): void {
    for (const announcement of this.commandAnnouncements) clearImmediate(announcement);
    this.commandAnnouncements.clear();
    for (const state of this.sessions.values()) {
      try {
        state.reader?.stop();
        state.session.close();
      } catch {
        // best-effort cleanup on connection close
      }
    }
    this.sessions.clear();
  }

  /**
   * Report an UpdatePlan tool call as an ACP plan update, so the client can show
   * the agent's task list. The tool carries the whole list on every call, which
   * matches ACP replacing the plan on each update.
   */
  private async emitPlan(
    sessionId: string,
    cx: AgentContext,
    toolName: string | undefined,
    input: unknown,
  ): Promise<void> {
    if (toolName !== UPDATE_PLAN_TOOL) return;
    const entries = planEntriesFrom(input);
    if (!entries) return;
    await cx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "plan", entries },
    });
  }

  /**
   * Streamed Letta SDK message -> ACP session/update notification.
   * Returns true when the message was substantive turn activity.
   */
  private async forwardMessage(
    sessionId: string,
    state: AcpSessionState,
    message: SDKMessage,
    cx: AgentContext,
  ): Promise<boolean> {
    switch (message.type) {
      case "init":
        log(`turn started (agent ${message.agentId}, model ${message.model})`);
        return false;
      case "assistant":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "reasoning":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "tool_call": {
        const existing = state.toolCalls.get(message.toolCallId);
        // Continuation deltas carry an argument fragment and often no name, so
        // the SDK reports "?" for them: the first real name wins.
        const toolName =
          knownToolName(message.toolName) ??
          existing?.toolName ??
          message.toolName;
        const input = accumulateToolInput(
          existing?.input,
          message.rawArguments,
          message.toolInput,
        );
        await this.emitPlan(sessionId, cx, toolName, input.input);
        const diffContent = toolDiffContent(toolName, input.input);
        const hasDiff = existing?.hasDiff === true || diffContent.length > 0;
        const nativeTerminal =
          this.supportsTerminalOutput && isTerminalOutputTool(toolName);
        const addTerminal = nativeTerminal && existing?.hasTerminal !== true;
        state.toolCalls.set(message.toolCallId, {
          toolName,
          input,
          hasDiff,
          hasTerminal: existing?.hasTerminal === true || addTerminal,
        });
        state.lastToolCall = { id: message.toolCallId, name: toolName };
        // Partial JSON has no usable title or locations, so hold the card
        // steady until the arguments parse rather than flickering through
        // every fragment.
        const worthSending =
          !existing ||
          (input.complete &&
            (!existing.input.complete ||
              existing.input.rawArguments !== input.rawArguments));
        if (!worthSending) return true;
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: existing ? "tool_call_update" : "tool_call",
            toolCallId: message.toolCallId,
            title: toolTitle(toolName, input.input),
            kind: toolKind(toolName),
            status: "in_progress",
            rawInput: input.input,
            locations: toolLocations(input.input),
            ...(diffContent.length > 0
              ? { content: diffContent }
              : addTerminal
                ? {
                    content: [{ type: "terminal" as const, terminalId: message.toolCallId }],
                    _meta: {
                      terminal_info: {
                        terminal_id: message.toolCallId,
                        cwd: state.cwd,
                      },
                    },
                  }
                : {}),
          },
        });
        return true;
      }
      case "tool_result": {
        const toolCall = state.toolCalls.get(message.toolCallId);
        const rawOutput = parseToolOutput(message.content);
        state.toolCalls.delete(message.toolCallId);
        const locations = toolCall
          ? toolLocations(toolCall.input.input, toolOutputLine(rawOutput))
          : [];
        const nativeTerminal = toolCall?.hasTerminal === true;
        if (nativeTerminal) {
          // Zed creates the display-only terminal from terminal_info on the
          // initial call, then consumes output and exit as ordered updates.
          await cx.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: message.toolCallId,
              _meta: {
                terminal_output: {
                  terminal_id: message.toolCallId,
                  data: message.content,
                },
              },
            },
          });
        }
        const resultContent = toolResultContent(
          message.toolCallId,
          message.content,
          {
            includeTerminal: nativeTerminal,
            hasDiff: toolCall?.hasDiff,
            isError: message.isError,
          },
        );
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: message.toolCallId,
            status: message.isError ? "failed" : "completed",
            rawOutput,
            ...(locations.length > 0 ? { locations } : {}),
            ...(resultContent.length > 0 ? { content: resultContent } : {}),
            ...(nativeTerminal
              ? {
                  _meta: {
                    terminal_exit: {
                      terminal_id: message.toolCallId,
                      exit_code: message.isError ? 1 : 0,
                      signal: null,
                    },
                  },
                }
              : {}),
          },
        });
        return true;
      }
      case "error":
        log(`stream error: ${message.message}`);
        return false;
      default:
        // queue_update, loop_status, stream_event, retry — no ACP equivalent.
        return false;
    }
  }

  private toPromptResponse(
    state: AcpSessionState,
    result: SDKResultMessage,
  ): PromptResponse {
    if (result.success) {
      return { stopReason: "end_turn" };
    }
    let stopReason: StopReason;
    switch (result.errorCode) {
      case "interrupted":
        stopReason = "cancelled";
        break;
      case "max_steps":
        stopReason = "max_turn_requests";
        break;
      default:
        if (state.cancelled) {
          stopReason = "cancelled";
          break;
        }
        throw new Error(
          result.errorDetail ?? result.error ?? "Letta turn failed",
        );
    }
    return { stopReason };
  }

  /** Letta canUseTool callback -> ACP session/request_permission. */
  private async requestToolPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    context: CanUseToolContext | undefined,
  ): Promise<CanUseToolResponse> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        behavior: "deny",
        message: "Unknown ACP session",
      };
    }
    if (state.cancelled) {
      // The client context now outlives the turn, so nothing else stops a
      // request that raced session/abort from prompting the user again after
      // they pressed stop.
      log(`denying ${toolName}: prompt turn was cancelled`);
      return {
        behavior: "deny",
        message: "Prompt turn was cancelled",
        interrupt: true,
      };
    }
    return this.resolveToolPermission(
      sessionId,
      state,
      state.clientContext,
      toolName,
      toolInput,
      context,
    );
  }

  private async resolveToolPermission(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    toolName: string,
    toolInput: Record<string, unknown>,
    context: CanUseToolContext | undefined,
  ): Promise<CanUseToolResponse> {
    const workspaceEditorRead = await editorReadAutoAllows(
      state.modeId,
      toolName,
      toolInput,
      state.cwd,
    );
    if (modeAutoAllows(state.modeId, toolName) || workspaceEditorRead) {
      log(`auto-allowing ${toolName} (mode ${state.modeId})`);
      return { behavior: "allow", updatedInput: toolInput };
    }
    log(
      `permission requested for ${toolName}` +
        (state.promptActive ? "" : " (outside a prompt turn)"),
    );
    if (state.alwaysAllowed.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    // The approval carries the id of the tool call it belongs to. Without it
    // the client gets a permission card that matches no streamed tool call:
    // guessing by name attaches to the wrong card when several calls are in
    // flight, and the synthetic id orphans the card entirely.
    const toolCallId =
      context?.toolCallId ??
      (state.lastToolCall?.name === toolName
        ? state.lastToolCall.id
        : `${toolName}_${crypto.randomUUID()}`);
    const params = {
      sessionId,
      toolCall: {
        toolCallId,
        title: toolTitle(toolName, toolInput),
        kind: toolKind(toolName),
        status: "pending" as const,
        rawInput: toolInput,
        locations: toolLocations(toolInput),
      },
      options: [
        {
          optionId: "allow_once",
          name: `Allow ${toolName} once`,
          kind: "allow_once" as const,
        },
        {
          optionId: "allow_always",
          name: `Always allow ${toolName} this session`,
          kind: "allow_always" as const,
        },
        {
          optionId: "reject_once",
          name: "Reject",
          kind: "reject_once" as const,
        },
      ],
    };

    let response: RequestPermissionResponse;
    try {
      response = state.promptActive
        ? await cx.request(methods.client.session.requestPermission, params)
        : await withAcpRequestTimeout(
            (signal) =>
              cx.request(methods.client.session.requestPermission, params, {
                cancellationSignal: signal,
              }),
            {
              label: "Permission request",
              description: `approve ${toolName} outside a prompt turn`,
              timeoutMs: this.outOfTurnPermissionTimeoutMs,
            },
          );
    } catch (error) {
      log(`permission request for ${toolName} failed: ${String(error)}`);
      return {
        behavior: "deny",
        message: error instanceof Error ? error.message : String(error),
        interrupt: true,
      };
    }

    if (response.outcome.outcome === "cancelled") {
      return {
        behavior: "deny",
        message: "Prompt turn was cancelled",
        interrupt: true,
      };
    }
    switch (response.outcome.optionId) {
      case "allow_always":
        state.alwaysAllowed.add(toolName);
        return { behavior: "allow", updatedInput: toolInput };
      case "allow_once":
        return { behavior: "allow", updatedInput: toolInput };
      default:
        return { behavior: "deny", message: "User rejected this tool call" };
    }
  }

  private ensureAgent(): Promise<string> {
    if (!this.agentIdPromise) {
      this.agentIdPromise = this.resolveAgent();
      this.agentIdPromise.catch(() => {
        // Allow retry on the next session/new instead of caching the failure.
        this.agentIdPromise = null;
      });
    }
    return this.agentIdPromise;
  }

  private async resolveAgent(): Promise<string> {
    if (this.config.agentId) {
      log(`using existing agent ${this.config.agentId}`);
      return this.config.agentId;
    }
    log("creating a new Letta agent (set LETTA_AGENT_ID to reuse one)...");
    const agentId = await this.client.createAgent({
      // SDK 0.5 made personality presets opt-in. Keep the adapter's established
      // behavior instead of silently creating a zero-memory generic agent.
      personality: "memo",
      name: "Letta",
      description: "Letta agent driven through the Agent Client Protocol",
      model: this.config.model ?? DEFAULT_ACP_MODEL,
    });
    log(
      `created agent ${agentId} — set LETTA_AGENT_ID=${agentId} to keep using it`,
    );
    return agentId;
  }
}

function sessionTitle(conversation: LettaConversation): string | undefined {
  const source = conversation.summary ?? conversation.description;
  if (!source) return undefined;
  const title = source.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length <= 256 ? title : `${title.slice(0, 255)}…`;
}

/**
 * The SDK reports "?" when a streamed tool_call chunk omits the function name,
 * which every continuation fragment does. Treat that as "unknown" so the name
 * from the opening chunk survives.
 */
function knownToolName(toolName: string): string | undefined {
  if (!toolName || toolName === "?") return undefined;
  return toolName;
}

/** Convert ACP transport shapes to the Agent SDK's keyed MCP configuration. */
export function toSdkMcpServers(
  servers: readonly McpServer[] | undefined,
): McpServers {
  const configs: Array<[string, McpServers[string]]> = [];
  for (const server of servers ?? []) {
    if (!("type" in server)) {
      configs.push([
        server.name,
        {
          command: server.command,
          args: server.args,
          env: Object.fromEntries(
            server.env.map(({ name, value }) => [name, value]),
          ),
        },
      ]);
      continue;
    }
    if (server.type === "http" || server.type === "sse") {
      configs.push([
        server.name,
        {
          type: server.type,
          url: server.url,
          headers: Object.fromEntries(
            server.headers.map(({ name, value }) => [name, value]),
          ),
        },
      ]);
      continue;
    }
    log("MCP server skipped: ACP transport is not supported");
  }
  return Object.fromEntries(configs);
}

/** ACP prompt content blocks -> Letta multimodal message content. */
export function toLettaContent(blocks: ContentBlock[]): MessageContentItem[] {
  const content: MessageContentItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        if (IMAGE_MEDIA_TYPES.has(block.mimeType)) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
              data: block.data,
            },
          });
        }
        break;
      case "resource_link":
        content.push({ type: "text", text: `[Referenced file: ${block.uri}]` });
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          content.push({
            type: "text",
            text: `<context uri="${resource.uri}">\n${resource.text}\n</context>`,
          });
        }
        break;
      }
      default:
        // audio and future block types are not advertised in promptCapabilities
        break;
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    log(`timing: ${label} ${Math.round(performance.now() - started)}ms`);
  }
}

function log(message: string): void {
  // stdout carries the ACP JSON-RPC stream; all logging goes to stderr.
  console.error(`[letta-acp] ${message}`);
}
