import type { PlanEntry, PlanEntryStatus } from "@agentclientprotocol/sdk";

/**
 * Map Letta's task-list tool onto ACP plan updates.
 *
 * The harness tracks work with an `UpdatePlan` tool whose input is
 * `{ plan: [{ step, status }] }` — it sends the whole list on every call, which
 * matches ACP's rule that each plan update replaces the previous one. Letta's
 * statuses are already ACP's statuses; ACP also requires a priority, which the
 * tool does not carry, so every entry is reported as medium.
 */

export const UPDATE_PLAN_TOOL = "UpdatePlan";

const STATUSES: readonly PlanEntryStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

function isPlanStatus(value: unknown): value is PlanEntryStatus {
  return (
    typeof value === "string" &&
    (STATUSES as readonly string[]).includes(value)
  );
}

/**
 * ACP plan entries for an UpdatePlan tool input, or null when the input does not
 * yet hold a complete plan — streaming argument fragments fail to parse, so this
 * only fires once the list is whole.
 */
export function planEntriesFrom(input: unknown): PlanEntry[] | null {
  const plan = (input as { plan?: unknown } | null | undefined)?.plan;
  if (!Array.isArray(plan)) return null;

  const entries: PlanEntry[] = [];
  for (const raw of plan) {
    const step = (raw as { step?: unknown } | null | undefined)?.step;
    if (typeof step !== "string" || step.trim().length === 0) continue;
    const status = (raw as { status?: unknown } | null | undefined)?.status;
    entries.push({
      content: step,
      priority: "medium",
      status: isPlanStatus(status) ? status : "pending",
    });
  }
  return entries.length > 0 ? entries : null;
}
