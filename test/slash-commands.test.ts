import { describe, expect, test } from "bun:test";
import { buildAvailableCommands, runtimeSkills } from "../src/slash-commands.js";

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
