import { describe, expect, test } from "bun:test";
import { UPDATE_PLAN_TOOL, planEntriesFrom } from "../src/plan.js";

describe("plan mapping", () => {
  test("exposes the update plan tool name", () => {
    expect(UPDATE_PLAN_TOOL).toBe("UpdatePlan");
  });

  test("maps a full plan to ACP entries", () => {
    expect(
      planEntriesFrom({
        plan: [
          { step: "Trace probe and approval gates across code, tests, and reports", status: "completed" },
          { step: "Remove probe mode and Boolean approvals; align docs and tests", status: "in_progress" },
          { step: "Run focused verification and inspect final diff", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "Trace probe and approval gates across code, tests, and reports", priority: "medium", status: "completed" },
      { content: "Remove probe mode and Boolean approvals; align docs and tests", priority: "medium", status: "in_progress" },
      { content: "Run focused verification and inspect final diff", priority: "medium", status: "pending" },
    ]);
  });

  test("returns null when there is no plan field", () => {
    expect(planEntriesFrom({})).toBeNull();
  });

  test("returns null for a streaming JSON fragment", () => {
    expect(planEntriesFrom('{"plan":[{"step":"x')).toBeNull();
  });

  test("normalizes an unknown status to pending", () => {
    expect(planEntriesFrom({ plan: [{ step: "x", status: "weird" }] })).toEqual([
      { content: "x", priority: "medium", status: "pending" },
    ]);
  });

  test("returns null when a step is blank", () => {
    expect(planEntriesFrom({ plan: [{ step: "   ", status: "pending" }] })).toBeNull();
  });
});
