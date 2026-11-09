import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/session-registry.js";

interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

type WireMessage = Record<string, unknown>;

interface FakeConfiguration {
  agent?: WireMessage;
  conversation?: WireMessage;
  updateGate?: Promise<void>;
  onUpdate?(payload: WireMessage): void;
  onInput?(conversation: WireMessage): void;
}

const CONFIGURATION_CATALOG = [
  { id: "test-model", handle: "test/model", label: "Test Model", description: "Deterministic test model", isDefault: true },
  { id: "test-reasoner-low", handle: "test/reasoner", label: "Reasoner Low", description: "Small context, low reasoning",
    updateArgs: { reasoning_effort: "low", context_window: 8192 } },
  { id: "test-reasoner-high", handle: "test/reasoner", label: "Reasoner High", description: "Small context, high reasoning", isFeatured: true,
    updateArgs: { reasoning_effort: "high", context_window: 8192 } },
  { id: "test-reasoner-large-high", handle: "test/reasoner", label: "Reasoner Large", description: "Large context, high reasoning",
    updateArgs: { reasoning_effort: "high", context_window: 32768 } },
];

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tempDirs: string[] = [];
const acpxResponseTimeoutSeconds = process.platform === "win32" ? 15 : 5;
const acpxTestTimeoutMs = process.platform === "win32" ? 45_000 : 10_000;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function startFakeAppServer(
  onReply?: (emitLate: () => void) => void,
  unconfirmedFirst = false,
  history: WireMessage[] = [],
  configuration: FakeConfiguration = {},
) {
  let replyCount = 0;
  let reloaded = false;
  let conversationTitle = TEST_CONVERSATION.summary;
  const savedAgent = configuration.agent ?? { id: TEST_RUNTIME.agent_id, model: "test/model", context_window_limit: 8192 };
  const savedConversation = configuration.conversation ?? {};
  const server = Bun.serve<{ channel: "control" | "stream" }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const channel = new URL(request.url).searchParams.get("channel") === "stream"
        ? "stream"
        : "control";
      if (server.upgrade(request, { data: { channel } })) return;
      return new Response("Expected websocket upgrade", { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as WireMessage;
        if (socket.data.channel !== "control") return;
        const sendStatus = () => socket.send(JSON.stringify({
          type: "update_device_status", runtime: TEST_RUNTIME,
          device_status: { is_online: true, is_processing: false,
            current_permission_mode: "standard", current_working_directory: "/server/project",
            supported_commands: ["reflect", "reload"],
            mod_commands: [{ id: reloaded ? "after-reload" : "project-status",
              description: "Runtime mod command", args: "<scope>" }],
            current_available_skills: [
              { name: "server-only-skill", description: "Agent skill on the runtime", source: "agent" },
            ] },
        }));

        switch (message.type) {
          case "runtime_start": {
            const requestId = requiredString(message.request_id);
            socket.send(JSON.stringify({
              type: "runtime_start_response",
              request_id: requestId,
              success: true,
              runtime: TEST_RUNTIME,
              agent: { id: TEST_RUNTIME.agent_id, model: "test/model", tools: [] },
              conversation: {
                id: TEST_RUNTIME.conversation_id,
                agent_id: TEST_RUNTIME.agent_id,
              },
            }));
            return;
          }
          case "sync":
            socket.send(JSON.stringify({ type: "sync_response", request_id: message.request_id,
              success: true, runtime: TEST_RUNTIME }));
            sendStatus();
            return;
          case "conversation_retrieve":
            socket.send(JSON.stringify({
              type: "conversation_retrieve_response",
              request_id: requiredString(message.request_id),
              success: true,
              conversation: { ...TEST_CONVERSATION, summary: conversationTitle, ...savedConversation },
            }));
            return;
          case "agent_retrieve":
            socket.send(JSON.stringify({ type: "agent_retrieve_response", request_id: message.request_id,
              success: true, agent: savedAgent }));
            return;
          case "conversation_update": {
            const body = message.body as WireMessage;
            if (typeof body.summary === "string") conversationTitle = body.summary;
            socket.send(JSON.stringify({ type: "conversation_update_response", request_id: message.request_id,
              success: true, conversation: { ...TEST_CONVERSATION, summary: conversationTitle } }));
            return;
          }
          case "conversation_messages_list":
            socket.send(JSON.stringify({
              type: "conversation_messages_list_response",
              request_id: requiredString(message.request_id),
              success: true,
              messages: [...history].reverse(),
              has_more: false,
            }));
            return;
          case "list_connect_providers":
            socket.send(JSON.stringify({
              type: "list_connect_providers_response",
              request_id: requiredString(message.request_id),
              success: true,
              providers: [{
                provider_names: ["test"],
                connected: { is_connected: true, provider_name: "test" },
              }],
            }));
            return;
          case "list_models":
            socket.send(JSON.stringify({
              type: "list_models_response",
              request_id: requiredString(message.request_id),
              success: true,
              entries: CONFIGURATION_CATALOG,
              available_handles: ["test/model", "test/reasoner"],
            }));
            return;
          case "update_model": {
            const payload = message.payload as WireMessage;
            configuration.onUpdate?.(payload);
            const apply = () => {
              const selected = CONFIGURATION_CATALOG.find((entry) => entry.id === payload.model_id)
                ?? CONFIGURATION_CATALOG.find((entry) => entry.handle === payload.model_handle);
              if (!selected) throw new Error(`Unknown test model ${JSON.stringify(payload)}`);
              savedConversation.model = selected.handle;
              const effort = payload.reasoning_effort ?? selected.updateArgs?.reasoning_effort;
              savedConversation.model_settings = effort ? { reasoning: { reasoning_effort: effort } } : {};
              savedConversation.context_window_limit = payload.context_window ?? selected.updateArgs?.context_window ?? 8192;
              socket.send(JSON.stringify({ type: "update_model_response", request_id: message.request_id,
                success: true, model_id: selected.id, model_handle: selected.handle }));
            };
            if (configuration.updateGate) void configuration.updateGate.then(apply);
            else apply();
            return;
          }
          case "execute_command": {
            const command = message.command_id;
            let output: string;
            if (command === "reflect") {
              expect(message.args).toBe("--instruction Remember architecture decisions");
              output = "Started a reflection pass for this conversation.";
            } else if (command === "project-status") {
              expect(message.args).toBe("src");
              output = "PROJECT_STATUS_OK";
            } else if (command === "reload") {
              reloaded = true;
              sendStatus();
              output = "Reloaded settings";
            } else {
              throw new Error(`Unexpected execute command: ${String(command)}`);
            }
            sendDelta(socket, { message_type: "slash_command_start", command_id: command });
            sendDelta(socket, {
              message_type: "slash_command_end",
              command_id: command,
              success: true,
              output,
            });
            return;
          }
          case "input": {
            const payload = message.payload as WireMessage;
            if (payload.kind !== "create_message") return;
            configuration.onInput?.({ ...savedConversation });
            const reply = () => {
              const runId = `run-acpx-${++replyCount}`;
              sendDelta(socket, {
                message_type: "tool_call_message",
                run_id: runId,
                tool_calls: [{
                  id: "call-acpx",
                  name: "Read",
                  arguments: JSON.stringify({ file_path: "/tmp/example.txt" }),
                }],
              });
              sendDelta(socket, {
                message_type: "tool_return_message",
                run_id: runId,
                tool_call_id: "call-acpx",
                tool_return: "example contents",
                status: "success",
              });
              sendDelta(socket, {
                message_type: "assistant_message",
                run_id: runId,
                content: "ACPX_OK",
              });
              sendDelta(socket, {
                message_type: "stop_reason",
                run_id: runId,
                stop_reason: "end_turn",
              });
              socket.send(JSON.stringify({
                type: "turn_finished", runtime: TEST_RUNTIME, run_id: runId,
                stop_reason: "end_turn",
              }));
              sendDelta(socket, { message_type: "usage_statistics", run_id: runId });
              onReply?.(() => {
                sendDelta(socket, {
                  message_type: "assistant_message", run_id: "run-late", content: "LATE_STDIO_OK",
                });
                sendDelta(socket, {
                  message_type: "stop_reason", run_id: "run-late", stop_reason: "end_turn",
                });
                socket.send(JSON.stringify({
                  type: "turn_finished", runtime: TEST_RUNTIME, run_id: "run-late",
                  stop_reason: "end_turn",
                }));
                sendDelta(socket, { message_type: "usage_statistics", run_id: "run-late" });
              });
              socket.send(JSON.stringify({
                type: "update_loop_status", runtime: TEST_RUNTIME,
                loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
              }));
            };
            if (unconfirmedFirst) {
              sendDelta(socket, { message_type: "user_message", content: "queued input" });
              // Run-tagged usage is non-rendered turn evidence in SDK 0.8;
              // a user echo alone no longer triggers synthetic completion.
              sendDelta(socket, { message_type: "usage_statistics", run_id: "run-unconfirmed" });
              socket.send(JSON.stringify({
                type: "update_loop_status", runtime: TEST_RUNTIME,
                loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
              }));
              setTimeout(reply, 25);
            } else {
              reply();
            }
            return;
          }
        }
      },
    },
  });
  servers.push(server);
  return `ws://${server.hostname}:${server.port}`;
}

const TEST_RUNTIME: RuntimeScope = {
  agent_id: "agent-acpx-test",
  conversation_id: "conv-acpx-test",
};

const TEST_CONVERSATION = {
  id: TEST_RUNTIME.conversation_id,
  agent_id: TEST_RUNTIME.agent_id,
  summary: "ACP client compatibility session",
  archived: false,
  updated_at: "2026-07-29T12:00:00.000Z",
};

function sendDelta(
  socket: { send(data: string): unknown },
  delta: WireMessage,
): void {
  socket.send(JSON.stringify({
    type: "stream_delta",
    runtime: TEST_RUNTIME,
    delta,
  }));
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty request id");
  }
  return value;
}

async function runAcpx(
  format: "json" | "quiet",
  command: string[] = ["exec", "Exercise the ACP tool lifecycle."],
  seedSession = false,
  unconfirmedFirst = false,
  naming: { env?: Record<string, string>; history?: WireMessage[] } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-acpx-"));
  tempDirs.push(home);
  const appServerUrl = startFakeAppServer(undefined, unconfirmedFirst, naming.history);
  const cwd = join(import.meta.dir, "..");
  if (seedSession) {
    const registry = new SessionRegistry(
      join(home, ".letta", "letta-acp", "sessions"),
      `remote:${appServerUrl}`,
    );
    await registry.record(TEST_RUNTIME.agent_id, TEST_RUNTIME.conversation_id, cwd);
  }

  const acpxPath = join(import.meta.dir, "..", "node_modules", ".bin", "acpx");
  const agentPath = join(import.meta.dir, "..", "src", "index.ts");
  // An argv array preserves executable and script paths containing spaces.
  mkdirSync(join(home, ".acpx"), { recursive: true });
  writeFileSync(join(home, ".acpx", "config.json"), JSON.stringify({
    agents: { "test-adapter": { argv: [process.execPath, agentPath] } },
  }));
  const child = Bun.spawn(
    [
      acpxPath,
      "--format",
      format,
      "--timeout",
      String(acpxResponseTimeoutSeconds),
      "test-adapter",
      ...command,
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LETTA_ACP_BACKEND: "remote",
        // Do not inherit a live Zed model override: this server has no model-switch handler.
        LETTA_ACP_MODEL: undefined,
        LETTA_ACP_NAMING_MODE: "off",
        LETTA_APP_SERVER_URL: appServerUrl,
        LETTA_AGENT_ID: TEST_RUNTIME.agent_id,
        ...naming.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`acpx exited ${exitCode}:\n${stderr}\n${stdout}`);
  }
  return { stdout, stderr, home, appServerUrl, cwd };
}

async function verifyMcpShutdownOnClientDisconnect(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-mcp-shutdown-"));
  tempDirs.push(home);
  const marker = join(home, "shutdown-marker");
  const pidFile = join(home, "mcp-pid");
  const appServerUrl = startFakeAppServer();
  const agentPath = join(import.meta.dir, "..", "src", "index.ts");
  const mcpPath = join(import.meta.dir, "fixtures", "stubborn-mcp-server.ts");
  const child = Bun.spawn([process.execPath, agentPath], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LETTA_ACP_BACKEND: "remote",
      LETTA_ACP_MODEL: undefined,
      LETTA_APP_SERVER_URL: appServerUrl,
      LETTA_AGENT_ID: TEST_RUNTIME.agent_id,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const send = (message: WireMessage) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush();
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      cwd: join(import.meta.dir, ".."),
      mcpServers: [
        {
          name: "stubborn",
          command: process.execPath,
          args: [mcpPath],
          env: [
            { name: "MCP_SHUTDOWN_MARKER", value: marker },
            { name: "MCP_PID_FILE", value: pidFile },
          ],
        },
      ],
    },
  });

  let buffer = "";
  let sessionOpened = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as WireMessage;
          if (message.id === 2 && message.result) {
            sessionOpened = true;
            break;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (sessionOpened) break;
    }
    expect(sessionOpened).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const mcpPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(mcpPid) && mcpPid > 0).toBe(true);

    child.stdin.end();
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(8_000).then(() => {
        throw new Error("adapter did not exit after ACP stdin closed");
      }),
    ]);
    expect(exitCode).toBe(0);
    if (process.platform === "win32") {
      let processExists = true;
      try {
        process.kill(mcpPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        processExists = false;
      }
      expect(processExists).toBe(false);
    } else {
      expect(existsSync(marker)).toBe(true);
    }
  } finally {
    if (child.exitCode === null) child.kill();
    if (existsSync(pidFile) && !existsSync(marker)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The fixture may already have exited while cleanup raced the test.
        }
      }
    }
  }
}

async function driveConfigurationScenario(
  url: string,
  handle: (message: any, send: (id: number, method: string, params: unknown) => void) => boolean | void,
  env: Record<string, string> = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "letta-acp-config-"));
  tempDirs.push(home);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "index.ts")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LETTA_ACP_BACKEND: "remote",
      LETTA_ACP_MODEL: undefined, LETTA_ACP_NAMING_MODE: "off", LETTA_APP_SERVER_URL: url,
      LETTA_AGENT_ID: TEST_RUNTIME.agent_id, ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const send = (id: number, method: string, params: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.stdin.flush();
  };
  let complete = false;
  const received: unknown[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const timer = setTimeout(() => child.kill(), process.platform === "win32" ? 20_000 : 8_000);
  try {
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    outer: for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        received.push({ id: message.id, error: message.error, update: message.params?.update?.sessionUpdate,
          options: (message.result?.configOptions ?? message.params?.update?.configOptions)?.map((option: any) =>
            ({ id: option.id, currentValue: option.currentValue })) });
        if (message.id === 1) send(2, "session/new", { cwd: home, mcpServers: [] });
        if (handle(message, send)) { complete = true; break outer; }
      }
    }
    if (!complete) throw new Error(`Configuration stdio scenario did not complete: ${JSON.stringify(received.slice(-12))}\n${await stderr}`);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited;
    await stderr;
  }
}

describe("acpx client compatibility", () => {
  test("stdio keeps title controls out of the composer while selecting and remembering a local model", async () => {
    const requests: string[] = [];
    const ollama = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ models: [{ name: "qwen:first" }, { name: "qwen:second" }] });
    } });
    const url = startFakeAppServer();
    let sessionId = "";
    let latest = "";
    try {
      await driveConfigurationScenario(url, (message, send) => {
        if (message.error) throw new Error(JSON.stringify(message.error));
        if (message.params?.update?.sessionUpdate === "config_option_update") {
          expect(message.params.update.configOptions.some((option: any) => option.id.startsWith("naming"))).toBe(false);
        }
        if (message.params?.update?.sessionUpdate === "agent_message_chunk") latest = message.params.update.content.text;
        if (message.id === 2) {
          sessionId = message.result.sessionId;
          expect(message.result.configOptions.map((option: any) => option.id)).toEqual(["permissions", "model"]);
          send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/naming method local" }] });
        }
        if (message.id === 3) {
          expect(latest).toContain("Method: Local");
          send(4, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/naming models" }] });
        }
        if (message.id === 4) {
          expect(latest).toContain("qwen:second");
          send(5, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/naming model qwen:second" }] });
        }
        if (message.id === 5) {
          expect(latest).toContain("Model: qwen:second");
          send(6, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/naming method cloud" }] });
        }
        if (message.id === 6) {
          expect(latest).toContain("Method: Cloud");
          send(7, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/naming method local" }] });
        }
        if (message.id === 7) {
          expect(latest).toContain("Model: qwen:second");
          expect(requests).toEqual(["GET /api/tags", "GET /api/tags"]);
          return true;
        }
      }, { LETTA_ACP_NAMING_ENDPOINT: `http://127.0.0.1:${ollama.port}` });
    } finally { ollama.stop(true); }
  }, acpxTestTimeoutMs);

  test("stdio restores persisted variants, refreshes slash-model selection, and orders changes before prompts", async () => {
    const updates: WireMessage[] = [];
    const inputs: WireMessage[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let coordinating = false;
    const configuration: FakeConfiguration = {
      agent: { id: TEST_RUNTIME.agent_id, model: "test/model", context_window_limit: 8192 },
      conversation: { model: "test/reasoner", context_window_limit: 32768,
        model_settings: { reasoning: { reasoning_effort: "high" } } },
      onUpdate(payload) { if (coordinating) updates.push(payload); },
      onInput(conversation) { inputs.push(conversation); },
    };
    const url = startFakeAppServer(undefined, false, [], configuration);
    let sessionId = "";
    let slashReturned = false;
    let slashPickerUpdated = false;
    let queued = false;
    let highConfirmed = false;
    let lowConfirmed = false;
    let lateChangeRejected = false;
    const value = (options: any[], id: string) => options.find((option) => option.id === id)?.currentValue;
    try {
      await driveConfigurationScenario(url, (message, send) => {
        if (message.error) {
          expect(message.id).toBe(13);
          expect(message.error.message).toMatch(/prompt/i);
          expect(inputs).toHaveLength(0);
          lateChangeRejected = true;
          release();
        }
        if (message.id === 2) {
          sessionId = message.result.sessionId;
          expect(value(message.result.configOptions, "model")).toBe("test-reasoner-large-high");
          expect(value(message.result.configOptions, "thought_level")).toBe("high");
          send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/model test-model" }] });
        }
        if (message.id === 3) {
          expect(message.result.stopReason).toBe("end_turn");
          slashReturned = true;
        }
        if (message.params?.update?.sessionUpdate === "config_option_update" &&
            value(message.params.update.configOptions, "model") === "test-model") slashPickerUpdated = true;
        if (slashReturned && slashPickerUpdated && !queued) {
          queued = true;
          coordinating = true;
          configuration.updateGate = gate;
          send(10, "session/set_config_option", { sessionId, configId: "model", value: "test-reasoner-high" });
          send(11, "session/set_config_option", { sessionId, configId: "thought_level", value: "low" });
          send(12, "session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the saved configuration" }] });
          send(13, "session/set_config_option", { sessionId, configId: "model", value: "test-model" });
        }
        if (message.id === 10) {
          expect(value(message.result.configOptions, "thought_level")).toBe("high");
          highConfirmed = true;
        }
        if (message.id === 11) {
          expect(value(message.result.configOptions, "thought_level")).toBe("low");
          lowConfirmed = true;
        }
        if (message.id === 12) {
          expect(message.result.stopReason).toBe("end_turn");
          expect(highConfirmed && lowConfirmed && lateChangeRejected).toBe(true);
          expect(updates).toHaveLength(2);
          expect(updates[0]?.model_id).toBe("test-reasoner-high");
          expect(inputs).toEqual([expect.objectContaining({ model: "test/reasoner", context_window_limit: 8192,
            model_settings: { reasoning: { reasoning_effort: "low" } } })]);
          return true;
        }
      });
    } finally { release(); }
  }, process.platform === "win32" ? 25_000 : 10_000);

  test("stdio delivers a background response after the prompt result without new input", async () => {
    let emitLate: (() => void) | undefined;
    const url = startFakeAppServer((emit) => { emitLate = emit; });
    const home = mkdtempSync(join(tmpdir(), "letta-acp-late-"));
    tempDirs.push(home);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "index.ts")], {
      env: { ...process.env, HOME: home, USERPROFILE: home, LETTA_ACP_BACKEND: "remote",
        LETTA_ACP_MODEL: undefined,
        LETTA_APP_SERVER_URL: url, LETTA_AGENT_ID: TEST_RUNTIME.agent_id },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const send = (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      child.stdin.flush();
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 4_000);
    let promptCompleted = false;
    let lateDelivered = false;
    let replacementCompleted = false;
    let replies = 0;
    let sessionId = "";
    let commandsReceived = false;
    let runtimeSkillsReceived = false;
    let runtimeCommandsReloaded = false;
    let titleReceived = false;
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      outer: for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.error) throw new Error(JSON.stringify(message.error));
          if (message.params?.update?.sessionUpdate === "available_commands_update") {
            expect(sessionId).not.toBe("");
            expect(message.params.update.availableCommands).toContainEqual({
              name: "reflect",
              description: "Start a manual reflection pass on the current conversation",
            });
            commandsReceived = true;
            if (message.params.update.availableCommands.some((c: { name: string }) => c.name === "server-only-skill")) {
              runtimeSkillsReceived = true;
            }
            const names = message.params.update.availableCommands.map((c: { name: string }) => c.name);
            if (names.includes("after-reload")) {
              expect(names).not.toContain("project-status");
              expect(names).not.toContain("clear");
              runtimeCommandsReloaded = true;
            }
          }
          if (message.params?.update?.content?.text === "ACPX_OK") replies += 1;
          if (message.params?.update?.sessionUpdate === "session_info_update") {
            expect(message.params.update.title).toBe("ACP restored conversation");
            titleReceived = true;
          }
          if (message.id === 1) send(2, "session/new", { cwd: home, mcpServers: [] });
          if (message.id === 2) {
            sessionId = message.result.sessionId;
            send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] });
          }
          if (message.id === 3) {
            expect(message.result.stopReason).toBe("end_turn");
            promptCompleted = true;
            expect(emitLate).toBeDefined();
            emitLate!();
          }
          if (message.method === "session/update" &&
              message.params.update.content?.text === "LATE_STDIO_OK") {
            expect(promptCompleted).toBe(true);
            expect(lateDelivered).toBe(false);
            lateDelivered = true;
            send(4, "session/prompt", { sessionId, prompt: [{ type: "text", text: "second" }] });
          }
          if (message.id === 4) {
            expect(message.result.stopReason).toBe("end_turn");
            expect(replies).toBe(2);
            expect(commandsReceived).toBe(true);
            expect(runtimeSkillsReceived).toBe(true);
            replacementCompleted = true;
            send(5, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/reload" }] });
          }
          if (message.id === 5) {
            expect(message.result.stopReason).toBe("end_turn");
            expect(runtimeCommandsReloaded).toBe(true);
            send(6, "session/prompt", { sessionId, prompt: [{ type: "text", text: "/rename ACP restored conversation" }] });
          }
          if (message.id === 6) {
            expect(message.result.stopReason).toBe("end_turn");
            expect(titleReceived).toBe(true);
            send(7, "session/list", { cwd: home });
          }
          if (message.id === 7) {
            expect(message.result.sessions).toContainEqual(expect.objectContaining({
              sessionId, title: "ACP restored conversation",
            }));
            break outer;
          }
        }
      }
      expect(timedOut).toBe(false);
      expect(lateDelivered).toBe(true);
      expect(replacementCompleted).toBe(true);
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await child.exited;
      await stderr;
    }
  }, 6_000);

  test("completes a prompt through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet");
    expect(stdout.trim()).toBe("ACPX_OK");
  }, acpxTestTimeoutMs);

  test("configures title naming through a real ACP client without a model turn", async () => {
    const { stdout } = await runAcpx("quiet", ["exec", "/naming method auto"]);
    expect(stdout).toContain("Method: Auto");
    expect(stdout).toContain("without inference");
    expect(stdout).not.toContain("ACPX_OK");
  }, acpxTestTimeoutMs);

  test("dispatches manual reflection through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet", [
      "exec", "/reflect --instruction Remember architecture decisions",
    ]);
    expect(stdout.trim()).toBe("Started a reflection pass for this conversation.");
  }, acpxTestTimeoutMs);

  test("executes a runtime-advertised mod command through a real ACP client", async () => {
    // Even an immediate prompt on a fresh session must wait for discovery.
    const { stdout } = await runAcpx("quiet", ["exec", "/project-status src"]);
    expect(stdout.trim()).toBe("PROJECT_STATUS_OK");
  }, acpxTestTimeoutMs);

  test("switches models while accepting picker refresh notifications through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet", ["exec", "/model test-reasoner-high"]);
    expect(stdout).toContain("Model switched to");
    expect(stdout).toContain("test/reasoner");
  }, acpxTestTimeoutMs);

  test("persists an exact conversation rename through a real ACP client", async () => {
    const { stdout } = await runAcpx("quiet", ["exec", "/rename A precise saved title"]);
    expect(stdout.trim()).toBe("Conversation renamed to: A precise saved title");
  }, acpxTestTimeoutMs);

  test("retitles through a local model without forwarding the command to the agent", async () => {
    let inferenceCalls = 0;
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/chat");
      const body = await request.json() as WireMessage;
      expect(body).toMatchObject({ model: "test-qwen", think: false, stream: false });
      expect(JSON.stringify(body.messages)).toContain("Focus on command discovery");
      inferenceCalls++;
      return Response.json({ message: { content: "ACP Command Discovery" } });
    } });
    try {
      const { stdout } = await runAcpx("quiet", ["exec", "/retitle Focus on command discovery"], false, false, {
        env: { LETTA_ACP_NAMING_MODE: "local", LETTA_ACP_NAMING_MODEL: "test-qwen",
          LETTA_ACP_NAMING_ENDPOINT: `http://127.0.0.1:${local.port}` },
        history: [{ message_type: "user_message", content: "Make skills visible in Zed" },
          { message_type: "assistant_message", content: "Use runtime skill inventory" }],
      });
      expect(stdout.trim()).toBe("Conversation renamed to: ACP Command Discovery");
      expect(inferenceCalls).toBe(1);
    } finally { local.stop(true); }
  }, acpxTestTimeoutMs);

  test("a real ACP client waits past an unconfirmed synthetic completion", async () => {
    const { stdout } = await runAcpx("quiet", undefined, false, true);
    expect(stdout.trim()).toBe("ACPX_OK");
  }, acpxTestTimeoutMs);

  test("records a new ACP session for discovery", async () => {
    const { home, appServerUrl, cwd } = await runAcpx("quiet");
    const registry = new SessionRegistry(
      join(home, ".letta", "letta-acp", "sessions"),
      `remote:${appServerUrl}`,
    );

    expect(await registry.list(TEST_RUNTIME.agent_id, cwd)).toEqual([
      expect.objectContaining({ sessionId: TEST_RUNTIME.conversation_id, cwd }),
    ]);
  }, acpxTestTimeoutMs);

  test("lists project sessions through a real ACP client", async () => {
    const cwd = join(import.meta.dir, "..");
    const { stdout } = await runAcpx(
      "json",
      ["sessions", "list", "--filter-cwd", cwd],
      true,
    );

    expect(JSON.parse(stdout).sessions).toContainEqual(expect.objectContaining({
      sessionId: TEST_RUNTIME.conversation_id,
      title: "ACP client compatibility session",
      cwd,
    }));
  }, acpxTestTimeoutMs);

  test("waits for MCP subprocess cleanup after the client disconnects", async () => {
    await verifyMcpShutdownOnClientDisconnect();
  }, 12_000);

  test("emits a complete tool lifecycle as ACP notifications", async () => {
    const { stdout } = await runAcpx("json");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WireMessage);
    const updates = messages
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as WireMessage).update as WireMessage);

    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "tool_call",
      toolCallId: "call-acpx",
      status: "in_progress",
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-acpx",
      status: "completed",
    }));
    expect(updates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ACPX_OK" },
    });
  }, acpxTestTimeoutMs);
});
