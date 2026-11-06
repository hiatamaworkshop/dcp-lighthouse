/**
 * Retention of the collector's daily gz files (ROADMAP C6, user-approved 2026-11-06):
 * nothing is deleted while the disk has room; when free space falls under LOW, the OLDEST
 * day files go, only as many as bring it back to TARGET.
 *
 * Never deleted: the last KEEP_RECENT_DAYS days, every holdout's week (spent or not — a
 * spent week is the record behind a verdict; the unspent one is the single look still to
 * come) with the reports' reach around it (2 days of history before, 2 days of late
 * arrivals after), and anything that is not a finished `YYYY-MM-DD.jsonl.gz` (today's raw
 * file, gaps.jsonl, collector-state.json).
 *
 * A deleted day must not read as a quiet day: the harness takes a missing day file for
 * "no events", with no gap and no blindness. So every deletion is appended to
 * `pruned.jsonl`, and loadDayFiles refuses a range that touches a pruned day.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;

export const RETENTION_LOW_FREE_BYTES = 100 * GIB;
export const RETENTION_TARGET_FREE_BYTES = 120 * GIB;
export const RETENTION_KEEP_RECENT_DAYS = 14;
/** Days of history a report loads before `from`, and of late arrivals it reads after `to` (real-data-harness). */
export const RETENTION_HOLDOUT_REACH_BEFORE_DAYS = 2;
export const RETENTION_HOLDOUT_REACH_AFTER_DAYS = 2;
export const PRUNED_FILE = "pruned.jsonl";

export interface RetentionFile {
  name: string;
  bytes: number;
}

export interface RetentionPlan {
  /** none: room enough · delete: `victims` bring free space to TARGET · short: all that may go is not enough. */
  action: "none" | "delete" | "short";
  victims: RetentionFile[];
  freeAfterBytes: number;
  protectedCount: number;
}

const dayShift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The day a finished day file holds (undefined for anything else: raw .jsonl, state, logs). */
export function retentionDayOf(name: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(name);
  return m ? m[1] : undefined;
}

export function planRetention(input: {
  files: readonly RetentionFile[];
  freeBytes: number;
  todayDay: string;
  holdouts: readonly { from: string; to: string }[];
  lowBytes?: number;
  targetBytes?: number;
  keepRecentDays?: number;
}): RetentionPlan {
  const low = input.lowBytes ?? RETENTION_LOW_FREE_BYTES;
  const target = input.targetBytes ?? RETENTION_TARGET_FREE_BYTES;
  const recentFrom = dayShift(input.todayDay, -(input.keepRecentDays ?? RETENTION_KEEP_RECENT_DAYS) + 1);
  const candidates: { file: RetentionFile; day: string }[] = [];
  let protectedCount = 0;
  for (const file of input.files) {
    const day = retentionDayOf(file.name);
    if (day === undefined) continue;
    const held =
      day >= recentFrom ||
      input.holdouts.some(
        (h) => day >= dayShift(h.from, -RETENTION_HOLDOUT_REACH_BEFORE_DAYS) && day <= dayShift(h.to, RETENTION_HOLDOUT_REACH_AFTER_DAYS),
      );
    if (held) protectedCount++;
    else candidates.push({ file, day });
  }
  if (input.freeBytes >= low) return { action: "none", victims: [], freeAfterBytes: input.freeBytes, protectedCount };
  candidates.sort((a, b) => (a.day < b.day ? -1 : 1));
  const victims: RetentionFile[] = [];
  let free = input.freeBytes;
  for (const c of candidates) {
    if (free >= target) break;
    victims.push(c.file);
    free += c.file.bytes;
  }
  // gz sizes are a floor on what is freed (the disk may account more), so `short` is a plain shortfall against the target.
  return { action: free >= target ? "delete" : "short", victims, freeAfterBytes: free, protectedCount };
}

/** Record deleted days (append-only, like gaps.jsonl). */
export function recordPruned(dir: string, days: readonly string[], nowMs: number): void {
  if (days.length === 0) return;
  appendFileSync(join(dir, PRUNED_FILE), days.map((day) => JSON.stringify({ day, prunedAt: new Date(nowMs).toISOString() })).join("\n") + "\n");
}

/** The days deleted so far (empty when nothing ever was). An unreadable line is an error: a skipped line would read a pruned day as quiet. */
export function readPrunedDays(dir: string): string[] {
  const path = join(dir, PRUNED_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const day = (JSON.parse(l) as { day?: unknown }).day;
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${PRUNED_FILE}: unreadable line ${l.slice(0, 60)}`);
      return day;
    });
}

/**
 * The refusal for a report range that touches a pruned day (undefined when it touches none).
 * `fromDay` is the first day a report loads; the late-arrival days after `toDay` count too.
 * A range with neither bound is "everything present" and is not refused.
 */
export function prunedRangeRefusal(pruned: readonly string[], range: { fromDay?: string; toDay?: string }): string | undefined {
  if (range.fromDay === undefined && range.toDay === undefined) return undefined;
  const hi = range.toDay === undefined ? undefined : dayShift(range.toDay, RETENTION_HOLDOUT_REACH_AFTER_DAYS);
  const hit = pruned.filter((d) => (range.fromDay === undefined || d >= range.fromDay) && (hi === undefined || d <= hi)).sort();
  if (hit.length === 0) return undefined;
  return `refusing: ${hit.join(", ")} ${hit.length === 1 ? "was" : "were"} deleted by the retention rule (${PRUNED_FILE}); a deleted day would read as a quiet one`;
}
