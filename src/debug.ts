/**
 * Internal turn-lifecycle tracing.
 *
 * The ACP byte stream shows what the client sees, never why: pump outcomes,
 * per-round deadlines, and the server's active-run list are all decided inside
 * the adapter, so bugs in that coordination have to be inferred from gaps
 * between notifications. This channel states them directly — enough to tell a
 * stale run from a working one without guessing.
 *
 * Off by default and stderr-only, so records never corrupt ACP stdout.
 * Logging can still add timing overhead.
 */

export interface DebugRecord {
  /** What happened, as a stable token for log filtering. */
  ev: string;
  [key: string]: unknown;
}

let channel: string | null = null;

function configured(): string | null {
  const env = process.env.LETTA_ACP_DEBUG;
  const value = env?.trim();
  return value ? value : null;
}

/** True when the channel is on — for callers with expensive fields to build. */
export function debugEnabled(): boolean {
  channel ??= configured();
  return channel !== null;
}

/** Emit one record: a single stderr line, prefixed for unambiguous filtering. */
export function debug(record: DebugRecord): void {
  const name = (channel ??= configured());
  if (name === null) return;
  // Never throw: a failure while reporting turn state must not become a turn
  // failure. Cycles are impossible here (plain data), so stringify is safe.
  try {
    const payload = JSON.stringify(record);
    console.error(`[letta-acp:debug] ${name} ${payload ?? "null"}`);
  } catch {
    // ignore
  }
}

