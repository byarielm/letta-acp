import { describe, expect, test } from "bun:test";
import { buildAvailableCommands, isExecuteCommand, runtimeCommands, runtimeSkills } from "../src/slash-commands.js";

describe("runtime skill discovery", () => {
  test("uses only the runtime inventory, not skills on the adapter host", () => {
    const skills = runtimeSkills({ current_available_skills: [
      { name: "agent-skill", description: "Agent-owned", source: "agent" },
      { name: "project-skill", description: "Project-owned", source: "project" },
    ] });
    expect(buildAvailableCommands(skills).filter((c) => c.name.endsWith("-skill")))
      .toEqual([
        { name: "agent-skill", description: "Agent-owned", input: { hint: "optional instructions" } },
        { name: "project-skill", description: "Project-owned", input: { hint: "optional instructions" } },
      ]);
    expect(buildAvailableCommands().map((c) => c.name)).not.toContain("working-on-letta-acp");
  });

  test("distinguishes an authoritative empty inventory from an unsupported field", () => {
    expect(runtimeSkills({ current_available_skills: [] })).toEqual([]);
    expect(runtimeSkills({})).toBeUndefined();
    expect(runtimeSkills({ current_available_skills: null })).toBeUndefined();
  });

  test("validates names, deduplicates, and preserves runtime precedence", () => {
    expect(runtimeSkills({ current_available_skills: [null, {},
      { name: "bad name", description: "Not invokable" },
      { name: "valid", description: "Project override" },
      { name: "valid", description: "Bundled duplicate" },
      { name: "fallback" },
    ] })).toEqual([
      { name: "fallback", description: "Invoke the fallback skill" },
      { name: "valid", description: "Project override" },
    ]);
    expect(buildAvailableCommands([{ name: "model", description: "Collision" }])
      .filter((c) => c.name === "model")).toHaveLength(1);
    expect(runtimeSkills({ current_available_skills: [{ name: "long", description: "a".repeat(200) }] })?.[0]?.description)
      .toHaveLength(160);
  });
});

describe("runtime command capabilities", () => {
  test("filters built-ins but keeps explicitly advertised mod commands", () => {
    const runtime = runtimeCommands({ supported_commands: ["reflect", "reload"], mod_commands: [
      { id: "project-status", description: "Inspect the project", args: "<scope>" },
    ] });
    const commands = buildAvailableCommands([], runtime);
    expect(commands.map((c) => c.name)).toContain("reflect");
    expect(commands.map((c) => c.name)).not.toContain("clear");
    expect(commands.map((c) => c.name)).not.toContain("remember");
    expect(commands.find((c) => c.name === "reflect")).not.toHaveProperty("input");
    expect(commands).toContainEqual({ name: "project-status", description: "Inspect the project", input: { hint: "<scope>" } });
    expect(isExecuteCommand("project-status", runtime)).toBe(true);
    expect(isExecuteCommand("remember", runtime)).toBe(false);
  });

  test("uses legacy built-ins only when support is unknown, not when empty", () => {
    expect(isExecuteCommand("reflect", runtimeCommands({}))).toBe(true);
    expect(isExecuteCommand("reflect", runtimeCommands({ supported_commands: [] }))).toBe(false);
    const known = runtimeCommands({ supported_commands: ["reflect"] });
    expect(isExecuteCommand("remember", runtimeCommands({}, known))).toBe(false);
  });

  test("validates metadata and reserves native and built-in command names", () => {
    const runtime = runtimeCommands({ supported_commands: ["reflect", null, {}], mod_commands: [
      null, {}, { id: "bad name" }, { id: "model", description: "Hijack" },
      { id: "clear", description: "Hijack unsupported built-in" },
      { id: "memory", description: "Real executable beats text fallback", args: "<section>" },
      { id: "memory", description: "Duplicate" },
    ] });
    expect(runtime.mods).toHaveLength(1);
    const commands = buildAvailableCommands([
      { name: "memory", description: "Skill collision" },
      { name: "clear", description: "Unsupported builtin collision" },
    ], runtime);
    expect(commands.filter((c) => c.name === "memory")).toEqual([
      { name: "memory", description: "Real executable beats text fallback", input: { hint: "<section>" } },
    ]);
    expect(commands.some((c) => c.name === "clear")).toBe(false);
    expect(runtimeCommands({}, runtime).mods).toEqual([]);
  });
});
