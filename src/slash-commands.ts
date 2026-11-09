import type { AvailableCommand } from "@agentclientprotocol/sdk";

/**
 * Slash-command surface exposed to ACP clients.
 *
 * Three kinds:
 * - native: implemented in the adapter itself (/model, /naming, /retitle, /rename)
 * - execute: dispatched to the Letta harness via the app-server protocol's
 *   `execute_command` (results stream back as slash_command_start/end)
 * - text: forwarded to the model as prompt text; the harness instructs the
 *   model that `/name` means "invoke that skill/behavior", which also covers
 *   every skill reported by the executing harness
 */

export interface ExecuteCommandSpec {
  name: string;
  description: string;
  hint?: string;
}

/** Commands the harness executes via the execute_command protocol path. */
export const EXECUTE_COMMANDS: ExecuteCommandSpec[] = [
  { name: "clear", description: "Clear in-context messages (moved to conversation history)" },
  {
    name: "compact",
    description: "Summarize conversation history immediately",
    hint: "all | sliding_window (empty for default)",
  },
  { name: "init", description: "Initialize or re-initialize agent memory" },
  { name: "doctor", description: "Audit and refine the agent's memory structure" },
  {
    name: "remember",
    description: "Ask the agent to remember conversation content",
    hint: "what to remember (empty to infer from context)",
  },
  {
    name: "reflect",
    description: "Start a manual reflection pass on the current conversation",
    // No argument-capability metadata is exposed. Cloud-owned reflection
    // rejects arguments, so only advertise the universally supported form.
  },
  {
    name: "context-limit",
    description: "Set or reset the max context window",
    hint: "tokens (empty to show current)",
  },
  { name: "reload", description: "Reload harness settings" },
  {
    name: "toolset",
    description: "Switch toolset",
    hint: "default | codex | gemini",
  },
];

/** TUI commands with no protocol path that the model handles well as text. */
const TEXT_COMMANDS: ExecuteCommandSpec[] = [
  { name: "memory", description: "Show the agent's memory blocks" },
  { name: "search", description: "Search past conversation history", hint: "query" },
  { name: "skills", description: "List available skills by source" },
  {
    name: "skill-creator",
    description: "Create a new skill interactively",
    hint: "what the skill should do",
  },
];

const EXECUTE_COMMAND_NAMES = new Set(EXECUTE_COMMANDS.map((c) => c.name));
const NATIVE_COMMAND_NAMES = new Set(["model", "naming", "retitle", "rename"]);

export interface RuntimeCommands {
  /** Undefined means the older runtime did not report a supported-command list. */
  supported?: ReadonlySet<string>;
  mods: ExecuteCommandSpec[];
}

function executeCommands(runtime?: RuntimeCommands): ExecuteCommandSpec[] {
  const builtins = EXECUTE_COMMANDS.filter((spec) =>
    !runtime?.supported || runtime.supported.has(spec.name));
  // The harness routes built-ins before mod commands; /model belongs to ACP.
  const mods = runtime?.mods.filter((spec) =>
    !NATIVE_COMMAND_NAMES.has(spec.name) && !EXECUTE_COMMAND_NAMES.has(spec.name)) ?? [];
  return [...builtins, ...mods];
}

export function isExecuteCommand(name: string, runtime?: RuntimeCommands): boolean {
  return executeCommands(runtime).some((spec) => spec.name === name);
}

/** Device status is a snapshot: an omitted mod list means no registered mods. */
export function runtimeCommands(raw: Record<string, unknown>, previous?: RuntimeCommands): RuntimeCommands {
  const supported = Array.isArray(raw.supported_commands)
    ? new Set(raw.supported_commands.filter((name): name is string =>
      typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name)))
    : previous?.supported;
  const mods = new Map<string, ExecuteCommandSpec>();
  if (Array.isArray(raw.mod_commands)) {
    for (const value of raw.mod_commands) {
      if (!value || typeof value !== "object") continue;
      const command = value as Record<string, unknown>;
      if (typeof command.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(command.id)) continue;
      if (NATIVE_COMMAND_NAMES.has(command.id) || EXECUTE_COMMAND_NAMES.has(command.id) || mods.has(command.id)) continue;
      const description = typeof command.description === "string" && command.description.trim()
        ? command.description.trim() : `Run /${command.id}`;
      mods.set(command.id, {
        name: command.id,
        description: description.slice(0, 160),
        ...(typeof command.args === "string" && command.args.trim()
          ? { hint: command.args.trim().slice(0, 160) } : {}),
      });
    }
  }
  return { supported, mods: [...mods.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Full command list, using the executing harness's scoped skill inventory. */
export function buildAvailableCommands(skills: readonly SkillEntry[] = [], runtime?: RuntimeCommands): AvailableCommand[] {
  const commands: AvailableCommand[] = [
    {
      name: "model",
      description: "Show available models or switch the session's model",
      input: { hint: "model handle (leave empty to list)" },
    },
    { name: "retitle", description: "Regenerate the saved conversation title", input: { hint: "optional naming guidance" } },
    { name: "naming", description: "Configure conversation titles without changing the chat model", input: { hint: "method off|auto|cloud|local · models · model <name>" } },
    { name: "rename", description: "Set an exact conversation title without a model", input: { hint: "exact title (1–100 characters)" } },
  ];
  const seen = new Set(commands.map((c) => c.name));
  for (const spec of [...executeCommands(runtime), ...TEXT_COMMANDS]) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    commands.push({
      name: spec.name,
      description: spec.description,
      ...(spec.hint ? { input: { hint: spec.hint } } : {}),
    });
  }
  for (const skill of skills) {
    if (seen.has(skill.name) || EXECUTE_COMMAND_NAMES.has(skill.name)) continue;
    seen.add(skill.name);
    commands.push({
      name: skill.name,
      description: skill.description,
      input: { hint: "optional instructions" },
    });
  }
  return commands;
}

export interface SkillEntry {
  name: string;
  description: string;
}

/** No filesystem fallback: adapter-local skills may not exist on the runtime. */
export function runtimeSkills(raw: Record<string, unknown>): SkillEntry[] | undefined {
  if (!Array.isArray(raw.current_available_skills)) return undefined;
  const skills = new Map<string, SkillEntry>();
  for (const value of raw.current_available_skills) {
    if (!value || typeof value !== "object") continue;
    const skill = value as Record<string, unknown>;
    // The harness name is the invocation target. Never invent a different slug.
    if (typeof skill.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(skill.name)) continue;
    const description = typeof skill.description === "string" && skill.description.trim()
      ? skill.description.trim() : `Invoke the ${skill.name} skill`;
    if (!skills.has(skill.name)) skills.set(skill.name, {
      name: skill.name,
      description: description.length > 160 ? `${description.slice(0, 157)}...` : description,
    });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
