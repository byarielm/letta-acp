import { describe, expect, spyOn, test } from "bun:test";
import { configFromEnv } from "../src/config.js";
import { debug } from "../src/debug.js";

// The module caches the label on first use, so the unconfigured case has to be
// observed before any test sets LETTA_ACP_DEBUG.
describe("turn-lifecycle debug channel", () => {
  test("stays silent while LETTA_ACP_DEBUG is unset", () => {
    delete process.env.LETTA_ACP_DEBUG;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      debug({ ev: "round", round: 1 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("labels each record and keeps it to one stderr line", () => {
    process.env.LETTA_ACP_DEBUG = "mac-fork";
    const errors: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      debug({ ev: "round", round: 2, outcome: "stream_end", activeRunIds: ["run-a"] });
    } finally {
      spy.mockRestore();
      delete process.env.LETTA_ACP_DEBUG;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveLength(1);
    const line = String(errors[0]?.[0]);
    expect(line).not.toContain("\n");
    const prefix = "[letta-acp:debug] mac-fork ";
    expect(line.startsWith(prefix)).toBe(true);
    expect(JSON.parse(line.slice(prefix.length))).toEqual({
      ev: "round",
      round: 2,
      outcome: "stream_end",
      activeRunIds: ["run-a"],
    });
  });

  test("reads the label from LETTA_ACP_DEBUG", () => {
    expect(configFromEnv({ LETTA_ACP_DEBUG: "philo" }).debugLabel).toBe("philo");
    expect(configFromEnv({ LETTA_ACP_DEBUG: "  " }).debugLabel).toBeUndefined();
    expect(configFromEnv({}).debugLabel).toBeUndefined();
  });
});
