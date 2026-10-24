/**
 * Pure lock-record and staleness policy for pi-mcp's cross-process OAuth
 * authorization lock. No filesystem, clock, or process access.
 */

import { z } from "zod";

// ─── Constants & Schema ───────────────────────────────────────────────────────

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000; // 3 × 30s heartbeat

export const LockRecordSchema = z.object({
  v: z.literal(1),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  nonce: z.string().min(1),
  createdAt: z.number(),
});

export type LockRecord = z.output<typeof LockRecordSchema>;

// ─── Pure Staleness Policy ────────────────────────────────────────────────────

export function parseLockRecord(raw: string): LockRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = LockRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    // WHY: JSON.parse on a string throws SyntaxError if the lock file is corrupt or
    // partially written. LockRecordSchema.safeParse does not throw. Unparseable lock
    // files map to null so isLockStale() can fall back to mtime-based staleness.
    return null;
  }
}

/**
 * Pure policy determining whether an existing lock file is stale and safe to reclaim.
 */
export function isLockStale(
  record: LockRecord | null,
  mtimeMs: number,
  now: number,
  self: { hostname: string; isPidAlive: (pid: number) => boolean },
): boolean {
  if (now - mtimeMs > STALE_MS) {
    return true;
  }
  if (record === null) {
    return false;
  }
  if (record.hostname === self.hostname && !self.isPidAlive(record.pid)) {
    return true;
  }
  return false;
}

export function formatHolderDetails(record: LockRecord | null): string | undefined {
  if (!record) return undefined;
  return `pid ${record.pid} on ${record.hostname}`;
}
