import type { AvailableCommand } from "@agentclientprotocol/sdk";

/**
 * Slash-command surface exposed to ACP clients.
 *
 * Three kinds:
 * - native: implemented in the adapter itself (/model)
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
    hint: "--instruction <focus> (optional)",
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

export function isExecuteCommand(name: string): boolean {
  return EXECUTE_COMMAND_NAMES.has(name);
}

/** Full command list, using the executing harness's scoped skill inventory. */
export function buildAvailableCommands(skills: readonly SkillEntry[] = []): AvailableCommand[] {
  const commands: AvailableCommand[] = [
    {
      name: "model",
      description: "Show available models or switch the session's model",
      input: { hint: "model handle (leave empty to list)" },
    },
  ];
  for (const spec of [...EXECUTE_COMMANDS, ...TEXT_COMMANDS]) {
    commands.push({
      name: spec.name,
      description: spec.description,
      ...(spec.hint ? { input: { hint: spec.hint } } : {}),
    });
  }
  const seen = new Set(commands.map((c) => c.name));
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
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
