/**
 * Replay harness and metrics for the real-data calibration period
 * (ROADMAP_BRIEF.md 2026-09-27 (3), stage 0). Lighthouse-side only.
 *
 * The extension of calibration.ts: that file draws SYNTHETIC null streams and
 * asks "does the curator fire at its design rate?"; this one replays a
 * RECORDED stream through the same curator and asks the same question, with
 * the three measurements the pre-registration fixed:
 *
 *   ① null calibration — R_real (alarm rate on the recorded stream) against
 *      FA_shuffle (the same regions with values permuted, which destroys
 *      dependence and keeps the marginal). The difference is dependence.
 *   ② injection — a known dip planted into one key's one window of a recorded
 *      region; power is measured against a truth this harness wrote.
 *   φ / lag-1 — the dispersion ratio and autocorrelation of window means.
 *
 * Replay is event-time only (a virtual clock: nothing here reads Date.now), so
 * the same recording and seed always give the same figures.
 *
 * Pre-registration rule 5 is enforced structurally: a trial whose span
 * overlaps a collection gap is BLIND and is counted apart, never folded into a
 * rate as a quiet trial.
 */
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  applyLens, effectiveN, floorToWindow, MIN_VALID_COUNT, resolveAlign, weightTotal, type LensEvent, type LensResult, type WindowStat,
} from "./lens.js";
import type { QObserveParams } from "./q-registry.js";
import { SnapshotCurator, familyWiseAlpha, isScorable, studentUpperTail, type SnapshotPackage, type SnapshotTile } from "./snapshot-curator.js";
import { mulberry32 } from "./calibration.js";
import { prunedRangeRefusal, readPrunedDays } from "./wiki-retention.js";
import { cleanHistoryByMedian } from "./comparison.js";
import {
  ORDINARY_VOLUME_BAND, forecastModel, forecastMse, forecastPoint, krigingWeights, persistenceWeights, pooledEventVariance, variogramAt,
} from "./forecast.js";

// ── Loading ─────────────────────────────────────────────────────────────────

/** A hole in event time, as the collector's gaps.jsonl records it. */
export interface GapSpan {
  fromTs: number;
  toTs: number;
}

export interface LoadedStream {
  /** Sorted by ts. `keys` carries wiki / type / namespace (namespace as a string). */
  events: LensEvent[];
  gaps: GapSpan[];
}

const DAY_MS = 86_400_000;

/**
 * Day 5 of the collection that began 2026-09-29: the first holdout day. Every
 * report refuses days from here on unless given `--holdout` (the single final
 * look), so the rule lives in one place rather than one copy per report.
 */
export const HOLDOUT_FROM_DAY = "2026-10-03";

/**
 * H3's own period (pre-registration revision 2026-10-06): days 1–4 from
 * 2026-10-07 are exploration, 2026-10-11…13 the holdout. Stage 1's holdout
 * (above) was spent on H1/H2/H4, so H3 cannot reuse it — it gets a fresh one.
 */
export const H3_HOLDOUT_FROM_DAY = "2026-10-11";
export const H3_HOLDOUT_TO_DAY = "2026-10-13";

/** Stage 1's holdout ended here; its single look was spent on 2026-10-06. */
export const HOLDOUT_TO_DAY = "2026-10-05";

/**
 * Stage 3's period (ROADMAP_BRIEF.md 2026-10-14 (12)): collection resumes and
 * 2026-10-15…18 are exploration, 2026-10-19…21 the holdout for the variogram
 * null's calibration. Sealed from the day it was decided, before any of its
 * data existed, so no exploration report can read it ahead of the single look.
 */
export const STAGE3_HOLDOUT_FROM_DAY = "2026-10-19";
export const STAGE3_HOLDOUT_TO_DAY = "2026-10-21";

/**
 * Stage 4 (ROADMAP_BRIEF.md 2026-10-22 (6)): one whole week, Monday to Sunday,
 * so the holdout holds every weekday once — the earlier 4+3 splits put
 * different weekdays on each side (2026-10-22 (4)). Sealed from 2026-10-22,
 * before any of its data existed.
 */
export const STAGE4_HOLDOUT_FROM_DAY = "2026-10-26";
export const STAGE4_HOLDOUT_TO_DAY = "2026-11-01";

/**
 * Stage 5 (ROADMAP C6, ROADMAP_BRIEF.md 2026-11-02 (6), user: "推奨通りで良い"): one whole
 * week, Monday to Sunday, for confirming what C4 / C7 change (the rate null, the volume
 * yardstick) — every earlier holdout is spent and so exploration data. Sealed from
 * 2026-11-02, before any of its data existed; its claim is pre-registered with the
 * design it confirms, before the single look.
 */
export const STAGE5_HOLDOUT_FROM_DAY = "2026-11-09";
export const STAGE5_HOLDOUT_TO_DAY = "2026-11-15";

/** A holdout period and the day its single look was taken (`spentOn` absent = not yet looked at: sealed). */
export interface Holdout {
  name: string;
  from: string;
  to: string;
  spentOn?: string;
}

/** Every holdout so far. Each verdict was taken from its single look and stands as recorded. */
export const HOLDOUTS: readonly Holdout[] = [
  { name: "stage 1's holdout", from: HOLDOUT_FROM_DAY, to: HOLDOUT_TO_DAY, spentOn: "2026-10-06" },
  { name: "H3's holdout", from: H3_HOLDOUT_FROM_DAY, to: H3_HOLDOUT_TO_DAY, spentOn: "2026-10-14" },
  { name: "stage 3's holdout", from: STAGE3_HOLDOUT_FROM_DAY, to: STAGE3_HOLDOUT_TO_DAY, spentOn: "2026-10-22" },
  { name: "stage 4's holdout", from: STAGE4_HOLDOUT_FROM_DAY, to: STAGE4_HOLDOUT_TO_DAY, spentOn: "2026-11-02" },
  { name: "stage 5's holdout", from: STAGE5_HOLDOUT_FROM_DAY, to: STAGE5_HOLDOUT_TO_DAY },
];

/**
 * What exploration may read: every day except an UNSPENT holdout's. A spent
 * holdout is exploration data from the day after its look (pre-registration
 * revision 2026-10-22, user approved): its verdict was taken once and is never
 * re-taken, and any change made after reading it is tested on a NEW holdout —
 * which is all the single look protects. Keeping spent holdouts shut protected
 * nothing and cost the only data on why a look failed; with 4+3-day splits it
 * also kept every Monday out of exploration (all three holdouts held one).
 * Returns the refusal message, or undefined when the range may be read.
 */
export function explorationRangeRefusal(fromDay: string, toDay: string, holdouts: readonly Holdout[] = HOLDOUTS): string | undefined {
  for (const h of holdouts) {
    if (h.spentOn === undefined && fromDay <= h.to && toDay >= h.from) {
      return `refusing: ${fromDay}…${toDay} touches ${h.name} (${h.from}…${h.to}), sealed until its single look`;
    }
  }
  return undefined;
}

/** The note a report prints when its range reads spent holdout days (undefined when it reads none). */
export function spentHoldoutNote(fromDay: string, toDay: string, holdouts: readonly Holdout[] = HOLDOUTS): string | undefined {
  const touched = holdouts.filter((h) => h.spentOn !== undefined && fromDay <= h.to && toDay >= h.from);
  if (touched.length === 0) return undefined;
  return `EXPLORATION over spent holdout days (${touched.map((h) => `${h.name} ${h.from}…${h.to}, verdict of ${h.spentOn}`).join("; ")}): ` +
    "those verdicts stand as recorded; nothing here re-takes them";
}

/**
 * The gate for stage 1's reports (run-real-data-report, run-otel-report) now
 * that their holdout is spent (decided 2026-10-06): `--holdout` is refused
 * outright, and exploration may read any day but an unspent holdout's
 * (explorationRangeRefusal). Returns the refusal message, or undefined.
 */
export function stage1RangeRefusal(fromDay: string, toDay: string, holdout: boolean): string | undefined {
  if (holdout) {
    return `refusing: stage 1's holdout (${HOLDOUT_FROM_DAY}…${HOLDOUT_TO_DAY}) was spent on 2026-10-06 — it had one look`;
  }
  return explorationRangeRefusal(fromDay, toDay);
}

/** H4's judgment day: the only full OTel Demo day recorded, inside stage 1's holdout (spent 2026-10-06). */
export const H4_JUDGMENT_DAY = "2026-10-03";

/**
 * run-otel-report's gate: stage1RangeRefusal. `reread` (`--reread-spent-h4-day`,
 * user decision 2026-10-16) opened exactly H4's spent judgment day as
 * exploration before spent holdouts were opened in general (2026-10-22); it is
 * still accepted, and still refuses to combine with --holdout, but no longer
 * needed — the report labels any read of a spent day as exploration either way.
 */
export function otelRangeRefusal(fromDay: string, toDay: string, holdout: boolean, reread: boolean): string | undefined {
  if (reread && holdout) return "refusing: --reread-spent-h4-day is exploration and does not combine with --holdout";
  return stage1RangeRefusal(fromDay, toDay, holdout);
}

/**
 * run-h3-report's gate, now that H3's single look was spent on 2026-10-14
 * (ROADMAP_BRIEF.md 2026-10-14): the same as stage 1's — `--holdout` refused
 * outright, exploration anywhere but an unspent holdout. Until then
 * run-h3-report only refused a holdout read that came too early, so the spent
 * look could be taken again.
 */
export function h3RangeRefusal(fromDay: string, toDay: string, holdout: boolean): string | undefined {
  if (holdout) {
    return `refusing: H3's holdout (${H3_HOLDOUT_FROM_DAY}…${H3_HOLDOUT_TO_DAY}) was spent on 2026-10-14 — it had one look`;
  }
  return stage1RangeRefusal(fromDay, toDay, false);
}

/**
 * Read a collector directory: `YYYY-MM-DD.jsonl` (today, raw) and
 * `YYYY-MM-DD.jsonl.gz` (rolled) day files plus gaps.jsonl. `fromDay`/`toDay`
 * are inclusive UTC days; omitted = everything present.
 *
 * The day in a file name is the collector's ARRIVAL day, not the event's: a
 * straggler from just before midnight lands in the next day's file, and events
 * re-fetched after downtime land in the day they were fetched — hours of them
 * after an outage across midnight (2026-10-21's second half sat in
 * 2026-10-22.jsonl). So the files after `toDay` are read as well, for their
 * events inside the range only (loadDayFiles). Arrival is never earlier than
 * event time, so no file before `fromDay` can hold a range event.
 */
export async function loadWikiDir(
  dir: string,
  range: { fromDay?: string; toDay?: string } = {},
): Promise<LoadedStream> {
  // Days of events number in the millions; one shared keys object per distinct
  // (wiki, type, namespace) instead of one per event keeps the heap in check.
  // Nothing mutates `keys` (shuffle/injection copy the event, not its keys).
  const pool = new KeysPool();
  return loadDayFiles(dir, range, (r) => ({
    ts: r.ts as number,
    value: r.value as number,
    keys: pool.get([String(r.wiki), String(r.type), String(r.namespace)], ["wiki", "type", "namespace"]),
  }));
}

/**
 * A span event that remembers its trace, as a 32-bit hash of the trace id (a
 * number, not the 32-hex string: a day of spans would otherwise hold millions
 * of strings). Lets the replay sample whole traces, as head samplers do.
 */
export interface TracedEvent extends LensEvent {
  traceHash?: number;
}

/** FNV-1a, 32 bit. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Read an OTLP receiver directory (otlp-receiver.ts): value 0 = ERROR span,
 * keys = service + op, `weight` = the sampling adjusted count, `traceHash` from
 * the trace half of `eid` (traceId:spanId). Same day-file and gaps.jsonl
 * conventions as the Wikimedia collector's directory.
 */
export async function loadOtelDir(
  dir: string,
  range: { fromDay?: string; toDay?: string } = {},
): Promise<{ events: TracedEvent[]; gaps: GapSpan[] }> {
  const pool = new KeysPool();
  return loadDayFiles(dir, range, (r): TracedEvent => {
    const weight = typeof r.weight === "number" && r.weight > 0 ? r.weight : 1;
    const colon = typeof r.eid === "string" ? r.eid.indexOf(":") : -1;
    return {
      ts: r.ts as number,
      value: r.value as number,
      keys: pool.get([String(r.service), String(r.op)], ["service", "op"]),
      ...(weight !== 1 ? { weight } : {}),
      ...(colon > 0 ? { traceHash: fnv1a32((r.eid as string).slice(0, colon)) } : {}),
    };
  });
}

/** Interns key objects: one per distinct tuple, shared by every event that carries it. */
class KeysPool {
  private readonly pool = new Map<string, Record<string, string>>();
  get(values: readonly string[], names: readonly string[]): Record<string, string> {
    const id = values.join("\u0000");
    let keys = this.pool.get(id);
    if (keys === undefined) {
      keys = Object.fromEntries(names.map((n, i) => [n, values[i]]));
      this.pool.set(id, keys);
    }
    return keys;
  }
}

/** Day files after `toDay` that are also read, for events that arrived late across midnight. */
const LATE_ARRIVAL_DAYS = 2;

const utcDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The day files a range reads, in order: the in-range days, then the late-arrival days after `toDay`
 * (`late`: keep only events whose `ts` is inside the range). The one place that decides which files stand
 * for a range — the loaders and the stage 5 coverage check (range-coverage.ts) share it.
 */
export function listDayFiles(dir: string, range: { fromDay?: string; toDay?: string }): Array<{ name: string; late: boolean }> {
  // The collector files an event under the UTC day it ARRIVED, not the day of its
  // `ts`: after an outage across midnight the backfill lands in the next day's file
  // (2026-10-21's second half sat in 2026-10-22.jsonl). So the files just after
  // `toDay` are read too, keeping only their events whose `ts` is inside the range;
  // the in-range files are read whole, as they always were. Nothing arrives before
  // its `ts`, so no file before `fromDay` can hold a range event.
  // A day the retention rule deleted would read as a quiet day (no events, no gap): refuse the range instead.
  const prunedRefusal = prunedRangeRefusal(readPrunedDays(dir), range);
  if (prunedRefusal !== undefined) throw new Error(prunedRefusal);
  const lateLimit = range.toDay === undefined ? undefined : utcDayOf(Date.parse(`${range.toDay}T00:00:00Z`) + LATE_ARRIVAL_DAYS * DAY_MS);
  const isLate = (day: string) => range.toDay !== undefined && lateLimit !== undefined && day > range.toDay && day <= lateLimit;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
    .filter((f) => {
      const day = f.slice(0, 10);
      return (range.fromDay === undefined || day >= range.fromDay) && (range.toDay === undefined || day <= range.toDay || isLate(day));
    })
    .sort();
  // A raw `.jsonl` next to a `.jsonl.gz` of the same day means the collector died
  // mid-rollover: the raw file was complete before gzip began, the .gz may be
  // truncated or a full copy. Reading both would double every event (or throw on
  // a cut gzip), so the raw file alone stands for that day.
  const rawDays = new Set(files.filter((f) => !f.endsWith(".gz")).map((f) => f.slice(0, 10)));
  const readable = files.filter((f) => {
    const shadowed = f.endsWith(".gz") && rawDays.has(f.slice(0, 10));
    if (shadowed) console.warn(`[real-data-harness] ${f} skipped: the raw day file exists (interrupted rollover)`);
    return !shadowed;
  });
  return readable.map((f) => ({ name: f, late: isLate(f.slice(0, 10)) }));
}

async function loadDayFiles(
  dir: string,
  range: { fromDay?: string; toDay?: string },
  toEvent: (raw: Record<string, unknown>) => LensEvent,
): Promise<LoadedStream> {
  const readable = listDayFiles(dir, range);
  const events: LensEvent[] = [];
  const rangeHi = range.toDay === undefined ? Infinity : Date.parse(`${range.toDay}T00:00:00Z`) + DAY_MS;
  for (const { name: f, late } of readable) {
    const raw = createReadStream(join(dir, f));
    const input = f.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line === "") continue;
      try {
        const ev = toEvent(JSON.parse(line) as Record<string, unknown>);
        if (!late || ev.ts < rangeHi) events.push(ev);
      } catch {
        // A torn final line from a crash: the collector's own restart logic skips these too.
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const lo = range.fromDay === undefined ? -Infinity : Date.parse(`${range.fromDay}T00:00:00Z`);
  const hi = range.toDay === undefined ? Infinity : Date.parse(`${range.toDay}T00:00:00Z`) + DAY_MS;
  const gapPath = join(dir, "gaps.jsonl");
  const gaps: GapSpan[] = [];
  if (existsSync(gapPath)) {
    for (const line of readFileSync(gapPath, "utf8").split("\n")) {
      if (line === "") continue;
      try {
        const g = JSON.parse(line) as GapSpan & { kind?: string };
        if (g.kind === "gap" && g.toTs > lo && g.fromTs < hi) gaps.push({ fromTs: g.fromTs, toTs: g.toTs });
      } catch {
        // torn line
      }
    }
  }
  // Holes the collector has not finalized yet (collector-state.json) may still
  // be filled — but until they are, nothing was seen there: blind, not quiet.
  const statePath = join(dir, "collector-state.json");
  if (existsSync(statePath)) {
    // Unreadable = refuse, not skip: skipping would read its holes as calm.
    const s = JSON.parse(readFileSync(statePath, "utf8")) as { openGaps?: GapSpan[] };
    for (const g of s.openGaps ?? []) {
      if (g.toTs > lo && g.fromTs < hi) gaps.push({ fromTs: g.fromTs, toTs: g.toTs });
    }
  }
  return { events, gaps };
}

// ── Slicing and planning ────────────────────────────────────────────────────

/** First index whose key is >= t (items sorted by that key). */
function lowerBound<T>(items: readonly T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const eventTs = (e: LensEvent): number => e.ts;
const windowStartOf = (w: WindowStat): number => w.windowStart;

/** Events in [from, to) — half-open, so adjacent spans never share a boundary event. */
export function sliceEvents(events: readonly LensEvent[], from: number, to: number): LensEvent[] {
  return events.slice(lowerBound(events, from, eventTs), lowerBound(events, to, eventTs));
}

function overlapsGap(gaps: readonly GapSpan[], from: number, to: number): boolean {
  return gaps.some((g) => g.toTs > from && g.fromTs < to);
}

/** One trial: reference [refFrom, obsFrom), observation [obsFrom, obsTo). */
export interface TrialPlan {
  refFrom: number;
  obsFrom: number;
  obsTo: number;
}

/**
 * Lay trials over the recording, `strideMs` apart. Any trial touching a
 * collection gap goes to `blind` — the replay may not read a hole as calm.
 * A trial touching an `exclude` span (a known-perturbed stretch, e.g. a fault
 * flag's ON interval) is not a null trial either; it is counted as `excluded`,
 * apart from blindness, because it was seen — just not under the null.
 */
export function planTrials(
  events: readonly LensEvent[],
  gaps: readonly GapSpan[],
  o: { spanMs: number; strideMs?: number; exclude?: readonly GapSpan[]; obsFromTs?: number },
): { trials: TrialPlan[]; blind: number; excluded: number } {
  const stride = o.strideMs ?? 2 * o.spanMs;
  const trials: TrialPlan[] = [];
  let blind = 0;
  let excluded = 0;
  if (events.length === 0) return { trials, blind, excluded };
  const first = events[0].ts;
  const last = events[events.length - 1].ts;
  for (let t = first; t + 2 * o.spanMs <= last; t += stride) {
    const plan = { refFrom: t, obsFrom: t + o.spanMs, obsTo: t + 2 * o.spanMs };
    // Trials observing before `obsFromTs` are not planned at all (neither scored
    // nor counted blind): the days before it only feed references and history.
    if (o.obsFromTs !== undefined && plan.obsFrom < o.obsFromTs) continue;
    if (overlapsGap(gaps, plan.refFrom, plan.obsTo)) blind++;
    else if (o.exclude !== undefined && overlapsGap(o.exclude, plan.refFrom, plan.obsTo)) excluded++;
    else trials.push(plan);
  }
  return { trials, blind, excluded };
}

// ── Alarm definition ────────────────────────────────────────────────────────

/**
 * Tiles that are STATISTICAL claims. `gap` is structural (an absence in
 * arrival, which a value shuffle leaves untouched) and `baseline` is not a
 * claim; neither belongs in a rate whose whole meaning is "how often does the
 * z-test fire on a null".
 */
const STATISTICAL_TAGS = new Set(["spike", "dip", "step_up", "step_down", "divergence"]);

function statisticalTiles(pkg: SnapshotPackage): SnapshotTile[] {
  return pkg.tiles.filter((t) => STATISTICAL_TAGS.has(t.shapeTag));
}

/**
 * Harness curators keep every tile (no `maxTiles` cap). The cap is a
 * presentation limit for a reader, and it drops the smallest-magnitude tiles
 * first — so a harness counting tiles by position, by group or by shape
 * undercounts exactly the packages that alarm most. Until 2026-10-14 (9) the
 * harness ran with the default 12: package alarm rates were unaffected (any
 * statistical tile), but per-position counts, step counts, gap-tile counts
 * and the targeted detections of H2 and H4 could undercount.
 */
const HARNESS_MAX_TILES = Infinity;

function newCurator(baseZ: number): SnapshotCurator {
  return new SnapshotCurator({ spikeZThreshold: baseZ, includeBaseline: true, maxTiles: HARNESS_MAX_TILES });
}

/**
 * The `--null-model` flag shared by the report entry points: absent or
 * "independent" = the curator every pre-registered figure was measured with
 * (returns undefined so each harness builds its own default, unchanged);
 * "overdispersed" = the between-window-variance null (2026-10-07).
 */
/**
 * The null model H3's judgment is read under (revision 2026-10-07 (2), user
 * approved): the independent null saturated the 60-minute arm at 100% on
 * exploration data, leaving the pre-registered correlation nothing to measure.
 */
export const H3_NULL_MODEL = "overdispersed";

export function curatorForNullModel(
  name: string | undefined,
  baseZ = 2.0,
  opts: { history?: boolean } = {},
): SnapshotCurator | undefined {
  if (name === undefined || name === "independent") return undefined;
  if (name === "variogram" && opts.history !== true) {
    // Without history the reference stands in for it (df 1, lags past the
    // reference extrapolated flat) — not the null 2026-10-14 (5) measured.
    throw new RangeError(`--null-model variogram needs history this report does not pass; use run-variogram-report`);
  }
  if (name === "overdispersed" || name === "variogram") {
    return new SnapshotCurator({ spikeZThreshold: baseZ, includeBaseline: true, nullModel: name, maxTiles: HARNESS_MAX_TILES });
  }
  throw new RangeError(`unknown --null-model "${name}" (independent | overdispersed | variogram)`);
}

// ── Shuffle null ────────────────────────────────────────────────────────────

/**
 * Permute `value` among events, keeping every ts and key where it is. The
 * marginal distribution (per stratum) and the arrival pattern survive; every
 * temporal or cross-event dependence between values does not.
 *
 * `strata` names the key(s) within which to permute: with a `group_by` lens
 * the permutation must stay inside each group, or the shuffle would also
 * destroy the per-group rates the lens is entitled to see.
 */
export function shuffleValues(
  events: readonly LensEvent[],
  rng: () => number,
  strata: readonly string[] = [],
): LensEvent[] {
  const buckets = new Map<string, number[]>();
  events.forEach((e, i) => {
    const label = strata.map((k) => e.keys?.[k] ?? "").join("|");
    let b = buckets.get(label);
    if (b === undefined) buckets.set(label, (b = []));
    b.push(i);
  });
  const out = events.map((e) => ({ ...e }));
  for (const idx of buckets.values()) {
    const vals = idx.map((i) => events[i].value);
    for (let i = vals.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    idx.forEach((ei, k) => { out[ei].value = vals[k]; });
  }
  return out;
}

/**
 * Thin a recorded stream event by event: each event survives with probability
 * `p` and carries weight 1/p (times any weight it already had). Independent
 * Bernoulli per event, seeded. H4 does NOT use this — real samplers keep or
 * drop whole traces (thinByTrace); this is the per-event model, kept for
 * streams with no trace structure.
 */
export function thinEvents(events: readonly LensEvent[], p: number, rng: () => number): LensEvent[] {
  if (!(p > 0 && p <= 1)) throw new RangeError(`sampling probability must be in (0, 1], got ${p}`);
  if (p === 1) return events.map((e) => ({ ...e }));
  const out: LensEvent[] = [];
  for (const e of events) {
    if (rng() < p) out.push({ ...e, weight: (e.weight ?? 1) / p });
  }
  return out;
}

/**
 * Head-sample by TRACE (the H4 replay unit, fixed 2026-09-30): a trace is kept
 * or dropped whole, the way a trace-id ratio sampler decides — all its spans
 * survive together, each weighted 1/p. Per-event thinning (thinEvents) would
 * make the spans of one trace independent, which real sampling never does: a
 * service called several times per trace sees its window's events kept or lost
 * in clumps, and that clumping is part of what H4 asks the weighted gate to
 * survive.
 *
 * Kept iff a seeded mix of the trace hash, read as a fraction, is < p — so for
 * one seed the p = 0.1 sample is a subset of the p = 0.5 one (consistent
 * sampling, as with a trace-id threshold). An event without a trace is refused:
 * silently thinning it on its own would be the per-event model again.
 */
export function thinByTrace(events: readonly TracedEvent[], p: number, seed: number): TracedEvent[] {
  if (!(p > 0 && p <= 1)) throw new RangeError(`sampling probability must be in (0, 1], got ${p}`);
  const out: TracedEvent[] = [];
  for (const e of events) {
    if (e.traceHash === undefined) throw new RangeError("event without a trace: cannot sample by trace");
    if (p === 1) { out.push({ ...e }); continue; }
    // murmur3 finalizer over hash ⊕ seed: an even spread even for similar trace ids.
    let h = (e.traceHash ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
    if (h / 4_294_967_296 < p) out.push({ ...e, weight: (e.weight ?? 1) / p });
  }
  return out;
}

// ── ① Null calibration ──────────────────────────────────────────────────────

export interface HarnessOptions {
  lens?: QObserveParams;
  /** Length of the reference span and of the observation span. Default 10 s (the pre-registered H1 window). */
  spanMs?: number;
  /** Distance between trial starts; default 2 × spanMs, so trials never share events. */
  strideMs?: number;
  seed?: number;
  baseZThreshold?: number;
  curator?: SnapshotCurator;
}

/** Alarm tally for one arm of the null measurement. */
export interface ArmTally {
  trials: number;
  /** Packages with at least one statistical (non-gap, non-baseline) tile. */
  flagged: number;
  rate: number;
  /** Reference could not ground a comparison — blind, excluded from the rate. */
  unusableReference: number;
  /** Packages carrying a `gap` tile, reported apart because they are not statistical alarms. */
  gapTilePackages: number;
}

export interface NullCalibrationResult {
  planned: number;
  /** Trials skipped because the span overlapped a collection gap. */
  blindByGap: number;
  /** Trials skipped because the span overlapped an `exclude` span (not under the null). */
  excluded: number;
  real: ArmTally;
  shuffled: ArmTally;
  /** familyWiseAlpha(baseZ): the only legitimate comparison point for either arm. */
  designTarget: number;
}

function tally(): ArmTally {
  return { trials: 0, flagged: 0, rate: 0, unusableReference: 0, gapTilePackages: 0 };
}

function scoreInto(arm: ArmTally, pkg: SnapshotPackage): void {
  if (!pkg.referenceUsable) {
    arm.unusableReference++;
    return;
  }
  arm.trials++;
  if (statisticalTiles(pkg).length > 0) arm.flagged++;
  if (pkg.tiles.some((t) => t.shapeTag === "gap")) arm.gapTilePackages++;
}

/**
 * R_real vs FA_shuffle. Both arms use the identical trial regions and the
 * identical lens; the shuffle permutes values over the whole (reference +
 * observation) region, within `group_by` strata when the lens has them.
 */
export function runNullCalibration(
  stream: LoadedStream,
  opts: HarnessOptions & {
    shuffleReps?: number;
    exclude?: readonly GapSpan[];
    /**
     * Hand the curator this much history before each reference (the variogram
     * null). Trials then read windows on one grid (windowedStream) and the
     * history leaves out windows touching `exclude` as well as gaps, so a fault
     * span does not widen the yardstick it is judged by. No shuffle arm with it.
     */
    historyMs?: number;
  } = {},
): NullCalibrationResult {
  const spanMs = opts.spanMs ?? 10_000;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  const reps = opts.shuffleReps ?? 1;
  const seed = opts.seed ?? 1;
  const { trials, blind, excluded } = planTrials(stream.events, stream.gaps, {
    spanMs, strideMs: opts.strideMs, exclude: opts.exclude,
  });

  const real = tally();
  const shuffled = tally();
  if (opts.historyMs !== undefined) {
    if (reps > 0) throw new RangeError("runNullCalibration: the shuffle arm does not run on a grid with history");
    const strideMs = opts.strideMs ?? 2 * spanMs;
    const grid = gridFor(stream, lens, spanMs, strideMs);
    const hist = historyGrid(stream, lens, opts.exclude ?? []);
    for (const t of trials) scoreInto(real, curateWithHistory(curator, grid, hist, t, opts.historyMs));
    real.rate = real.trials > 0 ? real.flagged / real.trials : 0;
    return { planned: trials.length + blind + excluded, blindByGap: blind, excluded, real, shuffled, designTarget: familyWiseAlpha(baseZ) };
  }
  trials.forEach((t, i) => {
    const region = sliceEvents(stream.events, t.refFrom, t.obsTo);
    const evaluate = (events: readonly LensEvent[]): SnapshotPackage => {
      const ref = events.filter((e) => e.ts < t.obsFrom);
      const obs = events.filter((e) => e.ts >= t.obsFrom);
      return curator.curate(applyLens(obs, lens), applyLens(ref, lens));
    };
    scoreInto(real, evaluate(region));
    for (let r = 0; r < reps; r++) {
      const rng = mulberry32((seed + Math.imul(i + 1, 2654435761) + r * 40503) >>> 0);
      scoreInto(shuffled, evaluate(shuffleValues(region, rng, lens.group_by ?? [])));
    }
  });
  real.rate = real.trials > 0 ? real.flagged / real.trials : 0;
  shuffled.rate = shuffled.trials > 0 ? shuffled.flagged / shuffled.trials : 0;
  return {
    planned: trials.length + blind + excluded, blindByGap: blind, excluded,
    real, shuffled, designTarget: familyWiseAlpha(baseZ),
  };
}

// ── ② Injection ─────────────────────────────────────────────────────────────

export interface InjectionOptions extends HarnessOptions {
  /** The key/value to hit, e.g. { key: "wiki", value: "enwiki" }. */
  target: { key: string; value: string };
  /**
   * Fraction of the target's events in the injected window that are pushed to
   * the failure side (value → 0 for "dip", 1 for "spike"). The TRUTH is the
   * mean shift this actually produced, recorded per trial — not this number.
   */
  fraction: number;
  direction?: "dip" | "spike";
}

export interface InjectionResult {
  planned: number;
  blindByGap: number;
  /** The target had < MIN_VALID_COUNT events in the injected window: unscorable by design, not a miss. */
  targetThin: number;
  unusableReference: number;
  trials: number;
  detected: number;
  power: number;
  /** Mean of the (exactly computed) shift in the target window's mean, over scored trials. */
  meanShiftTruth: number;
  /**
   * Mean Šidák family the curator actually corrected for (selection.scoredWindowCount),
   * over scored trials. H2's knob is G, but only scorable windows enter the family:
   * on thin keys G can grow while this does not, and then G is not what was tested.
   */
  meanFamilySize: number;
}

/** Top `n` values of `key` by event count, most frequent first. */
export function topKeyValues(events: readonly LensEvent[], key: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const v = e.keys?.[key] ?? "";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([v]) => v);
}

/** Keep only events whose `key` is one of `values` — the H2 group-count knob. */
export function restrictToKeyValues(events: readonly LensEvent[], key: string, values: readonly string[]): LensEvent[] {
  const keep = new Set(values);
  return events.filter((e) => keep.has(e.keys?.[key] ?? ""));
}

/**
 * Plant a known anomaly into one key's one window of a recorded observation
 * span and see whether the curator finds it. The injected window is the one
 * 80% of the way through the span on the lens's own grid (the calibration
 * fixture's burst position), so a straddled grid cannot halve the effect.
 */
export function runInjectionPower(stream: LoadedStream, opts: InjectionOptions): InjectionResult {
  const spanMs = opts.spanMs ?? 10_000;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  const windowMs = lens.window_ms ?? 1_000;
  const seed = opts.seed ?? 1;
  const direction = opts.direction ?? "dip";
  const grouped = (lens.group_by ?? []).length > 0;
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs: opts.strideMs });

  const out: InjectionResult = {
    planned: trials.length + blind, blindByGap: blind, targetThin: 0, unusableReference: 0,
    trials: 0, detected: 0, power: 0, meanShiftTruth: 0, meanFamilySize: 0,
  };
  let shiftSum = 0;
  let familySum = 0;
  trials.forEach((t, i) => {
    const ref = sliceEvents(stream.events, t.refFrom, t.obsFrom);
    const obs = sliceEvents(stream.events, t.obsFrom, t.obsTo).map((e) => ({ ...e }));
    if (obs.length === 0) { out.unusableReference++; return; }

    // The grid applyLens will actually use for this observation span.
    const origin = resolveAlign(lens) === "epoch" ? (lens.origin ?? 0) : obs[0].ts;
    // Anchored to the span itself, then snapped to the lens's grid: an epoch grid's
    // origin is 0 (or lens.origin), so origin + offset would land in 1970.
    const w0 = floorToWindow(t.obsFrom + Math.floor(0.8 * spanMs / windowMs) * windowMs, windowMs, origin);
    const w1 = w0 + windowMs;
    const inTarget = obs.filter((e) => e.ts >= w0 && e.ts < w1 && e.keys?.[opts.target.key] === opts.target.value);
    if (inTarget.length < MIN_VALID_COUNT) { out.targetThin++; return; }

    const rng = mulberry32((seed + Math.imul(i + 1, 2654435761)) >>> 0);
    const order = inTarget.map((_, k) => k);
    for (let k = order.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [order[k], order[j]] = [order[j], order[k]];
    }
    const before = inTarget.reduce((s, e) => s + e.value, 0) / inTarget.length;
    for (const k of order.slice(0, Math.round(opts.fraction * inTarget.length))) {
      inTarget[k].value = direction === "dip" ? 0 : 1;
    }
    const after = inTarget.reduce((s, e) => s + e.value, 0) / inTarget.length;

    const pkg = curator.curate(applyLens(obs, lens), applyLens(ref, lens));
    if (!pkg.referenceUsable) { out.unusableReference++; return; }
    out.trials++;
    shiftSum += after - before;
    familySum += pkg.selection.scoredWindowCount;
    const hit = statisticalTiles(pkg).some(
      (tile) => tile.regionStart < w1 && tile.regionEnd > w0 && (!grouped || tile.group === opts.target.value),
    );
    if (hit) out.detected++;
  });
  out.power = out.trials > 0 ? out.detected / out.trials : 0;
  out.meanShiftTruth = out.trials > 0 ? shiftSum / out.trials : 0;
  out.meanFamilySize = out.trials > 0 ? familySum / out.trials : 0;
  return out;
}

// ── ③ Labelled faults (H4: OTel Demo fault flags) ───────────────────────────

/**
 * One line of the fault-flag truth log (OTEL_DATA_DIR/flags.jsonl), written by
 * run-otel-flag-log.ts (manual) or run-otel-flag-schedule.ts (scheduled).
 * `confirmedTs` is when flagd was seen serving the new variant; null = the
 * write happened but was never confirmed; absent = a manual line (no check).
 */
export interface FlagTruthLine {
  ts: number;
  flag: string;
  state: "on" | "off";
  variant?: string;
  /** The variant's value as flagd serves it (e.g. paymentFailure "90%" is 0.95). */
  value?: unknown;
  confirmedTs?: number | null;
}

/** An interval during which a fault flag was ON. */
export interface FlagSpan extends GapSpan {
  variant?: string;
  value?: unknown;
  /** Both edges were confirmed against flagd (a still-open span: its start only). */
  confirmed: boolean;
}

/**
 * ON intervals of `flag`, from the truth log. Each edge is placed at its
 * confirmed time when there is one (the moment flagd served it), else at the
 * write. Repeated ONs (a variant change) extend the open span; an ON never
 * closed runs to `endTs`. A missing file is no truth at all, so it throws —
 * treating it as "never ON" would score fault time as null time.
 */
export function loadFlagTruth(dir: string, flag: string, endTs = Infinity): FlagSpan[] {
  const lines: FlagTruthLine[] = [];
  for (const line of readFileSync(join(dir, "flags.jsonl"), "utf8").split("\n")) {
    if (line === "") continue;
    try {
      const l = JSON.parse(line) as FlagTruthLine;
      if (l.flag === flag && (l.state === "on" || l.state === "off")) lines.push(l);
    } catch {
      // torn line
    }
  }
  const at = (l: FlagTruthLine) => (typeof l.confirmedTs === "number" ? l.confirmedTs : l.ts);
  lines.sort((a, b) => at(a) - at(b));
  const spans: FlagSpan[] = [];
  let open: FlagSpan | undefined;
  for (const l of lines) {
    if (l.state === "on") {
      if (open === undefined) {
        open = { fromTs: at(l), toTs: endTs, variant: l.variant, value: l.value, confirmed: typeof l.confirmedTs === "number" };
      } else {
        open.variant = l.variant;
        open.value = l.value;
        open.confirmed &&= typeof l.confirmedTs === "number";
      }
    } else if (open !== undefined) {
      open.toTs = at(l);
      open.confirmed &&= typeof l.confirmedTs === "number";
      spans.push(open);
      open = undefined;
    }
  }
  if (open !== undefined) spans.push(open);
  return spans;
}

/** ON spans widened by `settleMs` at the end: the fault's tail (in-flight requests) is not null time. */
export function flagExclusion(spans: readonly FlagSpan[], settleMs: number): GapSpan[] {
  return spans.map((s) => ({ fromTs: s.fromTs, toTs: s.toTs + settleMs }));
}

export interface FlagDetectionOptions extends HarnessOptions {
  /** The group the fault should show in (grouped lens), e.g. { key: "service", value: "payment" }. */
  target: { key: string; value: string };
  /** Skipped after each edge before a span counts as ON / OFF. Default 30 s. */
  settleMs?: number;
  /**
   * Hand the curator this much history before each reference (the variogram
   * null). The trial then sits on the stream's grid: the reference ends at the
   * last window boundary at or before the ON edge, the observation starts at
   * the first boundary at or after edge + settle (each moves < 1 window), and
   * the history leaves out every ON span and its tail.
   */
  historyMs?: number;
}

export interface FlagDetectionResult {
  planned: number;
  blindByGap: number;
  /** ON span shorter than settle + span: no observation fits inside it. */
  tooShort: number;
  /** The reference before the ON edge overlapped an earlier ON span (or its tail). */
  refContaminated: number;
  unusableReference: number;
  trials: number;
  /** A statistical tile inside the observation, in the target group (any group for a mixed lens). */
  detected: number;
  power: number;
  /** A statistical tile inside the observation in ANY group — the wiring check doesn't need the right group. */
  detectedAnyGroup: number;
}

/**
 * The wiring check H4 pre-registers: is a known ON interval detected at all?
 * One trial per ON span — reference = the `spanMs` just before the ON edge,
 * observation = `spanMs` starting `settleMs` after it. A miss at p = 1 is a
 * wiring (ingest / value mapping) problem to fix first, not a statistical result.
 */
export function runFlagDetection(
  stream: LoadedStream,
  spans: readonly FlagSpan[],
  opts: FlagDetectionOptions,
): FlagDetectionResult {
  const spanMs = opts.spanMs ?? 60_000;
  const settleMs = opts.settleMs ?? 30_000;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const lens: QObserveParams = opts.lens ?? { window_ms: 10_000, group_by: [opts.target.key] };
  const grouped = (lens.group_by ?? []).length > 0;
  const tails = flagExclusion(spans, settleMs);
  const out: FlagDetectionResult = {
    planned: spans.length, blindByGap: 0, tooShort: 0, refContaminated: 0, unusableReference: 0,
    trials: 0, detected: 0, power: 0, detectedAnyGroup: 0,
  };
  const onGrid = opts.historyMs !== undefined;
  const grid = onGrid ? gridFor(stream, lens, spanMs, spanMs) : undefined;
  const hist = onGrid ? historyGrid(stream, lens, tails) : undefined;
  const origin = stream.events.length > 0 ? stream.events[0].ts : 0;
  const w = lens.window_ms ?? 10_000;
  spans.forEach((s, i) => {
    const refTo = onGrid ? origin + Math.floor((s.fromTs - origin) / w) * w : s.fromTs;
    const refFrom = refTo - spanMs;
    const obsFrom = onGrid ? origin + Math.ceil((s.fromTs + settleMs - origin) / w) * w : s.fromTs + settleMs;
    const obsTo = obsFrom + spanMs;
    if (obsTo > s.toTs) { out.tooShort++; return; }
    if (tails.some((t, j) => j !== i && t.toTs > refFrom && t.fromTs < s.fromTs)) { out.refContaminated++; return; }
    if (overlapsGap(stream.gaps, refFrom, refTo) || overlapsGap(stream.gaps, obsFrom, obsTo)) { out.blindByGap++; return; }
    const pkg = grid !== undefined && hist !== undefined
      ? curateWithHistory(curator, grid, hist, { refFrom, obsFrom: refTo, obsTo: refTo + spanMs }, opts.historyMs ?? 0, { obsFrom, obsTo })
      : curator.curate(
          applyLens(sliceEvents(stream.events, obsFrom, obsTo), lens),
          applyLens(sliceEvents(stream.events, refFrom, refTo), lens),
        );
    if (!pkg.referenceUsable) { out.unusableReference++; return; }
    out.trials++;
    const tiles = statisticalTiles(pkg);
    if (tiles.length > 0) out.detectedAnyGroup++;
    if (tiles.some((t) => !grouped || t.group === opts.target.value)) out.detected++;
  });
  out.power = out.trials > 0 ? out.detected / out.trials : 0;
  return out;
}

/**
 * H4's pre-registered rule, applied mechanically — but only after the wiring
 * check passes. The pre-registration calls a p = 1 miss "a wiring problem to
 * fix first, not a statistical result"; the 2026-10-01 rehearsal printed
 * SUPPORTED over a run whose p = 1 detection was 0/1. The check passes when at
 * least one ON span was scored and more than half of the scored spans were
 * detected in the target group: broken wiring detects (almost) nothing, so a
 * majority tells "wired" from "not" without turning into a power claim
 * (pre-registration revision 2026-10-01 (2)).
 */
export function h4Verdict(o: {
  offRateP1: number;
  offRateP01: number;
  design: number;
  wiring: { detected: number; trials: number };
}): string {
  if (o.wiring.trials === 0) return "NO VERDICT: no ON span could be scored at p=1 (wiring check not run)";
  if (2 * o.wiring.detected <= o.wiring.trials) {
    return `NO VERDICT: wiring check failed (p=1 detected ${o.wiring.detected}/${o.wiring.trials}) — fix ingest or value mapping first`;
  }
  if (o.offRateP1 > o.design) {
    return "outside the rule: p=1 already exceeds the design rate (the unweighted model is off before weights enter)";
  }
  return o.offRateP01 > o.design
    ? "SUPPORTED (weighted windows exceed the design rate, unweighted do not)"
    : "REJECTED (both at or under the design rate)";
}

// ── H3: diurnal drift against the preceding equal-length span ──────────────

const HOUR_MS = 3_600_000;

export interface DiurnalBin {
  /**
   * The UTC o'clock nearest the observation's start: the hour boundary
   * h:00 the trial's reference and observation straddle most symmetrically.
   */
  hour: number;
  trials: number;
  flagged: number;
  rate: number;
  /** Mean value (bot share) of every event whose ts falls in this UTC hour, pooled over days. */
  level: number;
  /** |level(hour) − level(hour − 1)|: how far the diurnal curve moves across the boundary. */
  slope: number;
}

export interface DiurnalResult {
  bins: DiurnalBin[];
  /** Pearson over the bins that hold trials; NaN when either side has no variance. */
  correlation: number;
  blindByGap: number;
  unusableReference: number;
  designTarget: number;
}

/**
 * H3's measurement: lay "preceding span vs this span" trials over the
 * recording, bucket their alarms by the o'clock nearest the observation's
 * start, and correlate the per-hour alarm rate with how steeply the diurnal
 * curve moves across that o'clock. Nearest, not the hour the start falls in:
 * a trial starting at 11:50 compares 10:50–11:50 with 11:50–12:50, i.e. it
 * straddles 12:00 and must be read against |c(12) − c(11)|. Flooring put it
 * under 11 and smeared every sharp step into the flat hour before it. Trials step by `strideMs` (default span / 6) and so
 * overlap — they share events, which is fine for a rate per hour but means the
 * trial count is not a sample size.
 *
 * The curve is the bot share per UTC hour, because that is the statistic the
 * curator compares; the arrival volume's curve is not used (decided before H3
 * data was read, revision 2026-10-06).
 */
export function runDiurnalAlarms(
  stream: LoadedStream,
  opts: {
    spanMs: number; lens: QObserveParams; strideMs?: number; baseZThreshold?: number; curator?: SnapshotCurator;
    /** Hand the curator this much history before each reference (CurationContext.history); trials then read one grid (windowedStream). */
    historyMs?: number;
    /** Plan only trials observing from here on (planTrials); earlier days feed references and history. */
    obsFromTs?: number;
  },
): DiurnalResult {
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const level = hourlyLevel(stream);

  const strideMs = opts.strideMs ?? opts.spanMs / 6;
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs: opts.spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const grid = opts.historyMs === undefined ? undefined : gridFor(stream, opts.lens, opts.spanMs, strideMs);
  const arms = Array.from({ length: 24 }, tally);
  for (const t of trials) {
    let pkg: SnapshotPackage;
    if (grid === undefined) {
      const ref = sliceEvents(stream.events, t.refFrom, t.obsFrom);
      const obs = sliceEvents(stream.events, t.obsFrom, t.obsTo);
      pkg = curator.curate(applyLens(obs, opts.lens), applyLens(ref, opts.lens));
    } else {
      pkg = curateOnGrid(curator, grid, t, opts.historyMs!);
    }
    scoreInto(arms[new Date(t.obsFrom + HOUR_MS / 2).getUTCHours()], pkg);
  }
  const bins = arms.map((a, hour): DiurnalBin => ({
    hour, trials: a.trials, flagged: a.flagged, rate: a.trials > 0 ? a.flagged / a.trials : 0,
    level: level[hour], slope: Math.abs(level[hour] - level[(hour + 23) % 24]),
  }));
  const used = bins.filter((b) => b.trials > 0 && Number.isFinite(b.slope));
  return {
    bins,
    correlation: pearson(used.map((b) => b.rate), used.map((b) => b.slope)),
    blindByGap: blind,
    unusableReference: arms.reduce((a, b) => a + b.unusableReference, 0),
    designTarget: familyWiseAlpha(baseZ),
  };
}

// ── F1: periodic references, as contrasts (ROADMAP_BRIEF.md 2026-10-14 (2) item 3) ──

/**
 * What an observation window is compared against (runContrastDiurnal):
 *  - "preceding": the span before, pooled — the control, what production does;
 *  - "previous-day": the same span 24 h earlier, pooled;
 *  - "diff-in-diff": this window's move from the span before, against the same
 *    move a day earlier — (m_o − m̄_pre) − (m_{o−24h} − m̄_{pre−24h}), which
 *    cancels a level that differs from one day to the next.
 */
export type ContrastReference = "preceding" | "previous-day" | "diff-in-diff";

export const CONTRAST_REFERENCES: readonly ContrastReference[] = ["preceding", "previous-day", "diff-in-diff"];

export interface ContrastDiurnalResult extends DiurnalResult {
  reference: ContrastReference;
  trials: number;
  flagged: number;
  /** Observation windows that could not be scored (no events, or a partner window missing). */
  unscoredWindows: number;
}

/** Mean bot share per UTC hour, pooled over days — the curve H3 correlates with. */
function hourlyLevel(stream: LoadedStream): number[] {
  const sum = new Array<number>(24).fill(0);
  const cnt = new Array<number>(24).fill(0);
  for (const e of stream.events) {
    const h = new Date(e.ts).getUTCHours();
    sum[h] += e.value;
    cnt[h]++;
  }
  return sum.map((s, h) => (cnt[h] > 0 ? s / cnt[h] : NaN));
}

/**
 * The three references side by side, through ONE scorer, so they differ by the
 * reference alone. Each observation window is a contrast Σλᵢmᵢ with Σλᵢ = 0
 * (the window +1, its reference weighted −nₖ/N, and for diff-in-diff the
 * day-earlier pair with the opposite signs); under the variogram null its
 * variance is −ΣᵢΣⱼλᵢλⱼγ(tᵢ − tⱼ) + Σλᵢ²vᵢ (2026-10-14 (2)), γ̂ estimated the
 * way the curator does (pairs of windows, sampling variance subtracted) from
 * `historyMs` of windows ending where the observation starts, with γ̂'s own
 * error carried as the curator does (blocks → Satterthwaite Student-t) and
 * Šidák over the scored windows. No exact tails: an exploration scorer, not
 * the curator — read the arms against each other.
 *
 * Trials are those for which all three references exist: the observation,
 * the span before it, both a day earlier, and the full history, gap-free.
 */
export function runContrastDiurnal(
  stream: LoadedStream,
  opts: {
    spanMs: number; windowMs: number; historyMs: number; strideMs?: number; baseZThreshold?: number;
    /**
     * Power instead of false alarms: add this to the mean of the observation's
     * second half (window level, sampling variance unchanged), so every arm is
     * asked to find the same shift. Absent = the null.
     */
    injectDelta?: number;
  },
): ContrastDiurnalResult[] {
  const baseZ = opts.baseZThreshold ?? 2.0;
  const W = opts.windowMs;
  const strideMs = opts.strideMs ?? opts.spanMs / 6;
  const grid = gridFor(stream, { window_ms: W }, opts.spanMs, strideMs);
  if (DAY_MS % W !== 0 || opts.historyMs % W !== 0) throw new RangeError(`a day and historyMs must be multiples of window_ms ${W}`);
  const level = hourlyLevel(stream);

  // Every window once, by grid index.
  const all = grid.slice(-Infinity, Infinity).windows;
  const origin = all.length > 0 ? all[0].windowStart : 0;
  const len = all.length > 0 ? Math.round((all[all.length - 1].windowStart - origin) / W) + 1 : 0;
  const m = new Float64Array(len).fill(NaN);
  const v = new Float64Array(len);
  const n = new Float64Array(len);
  for (const w of all) {
    if (!isScorable(w) || !(effectiveN(w) > 1)) continue;
    const i = Math.round((w.windowStart - origin) / W);
    m[i] = w.mean;
    v[i] = Math.max(0, w.sumSq / weightTotal(w) - w.mean * w.mean) / (effectiveN(w) - 1);
    n[i] = effectiveN(w);
  }

  const K = opts.spanMs / W;
  const D = DAY_MS / W;
  const H = opts.historyMs / W;
  const lags = new Set<number>();
  for (let h = 1; h <= 2 * K; h++) lags.add(h);
  for (let h = D - 2 * K; h <= D + 2 * K; h++) lags.add(h);
  const lagList = [...lags];

  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs: opts.spanMs, strideMs });
  const out = CONTRAST_REFERENCES.map((reference) => ({ reference, arms: Array.from({ length: 24 }, () => ({ trials: 0, flagged: 0 })), unscored: 0 }));
  let extraBlind = 0;

  // γ̂'s own error, as the curator carries it (latentModel): the history is cut
  // into BLOCKS, each block's γ̂ (pairs starting in it) gives its own contrast
  // variance, and their spread sets the degrees of freedom of a Satterthwaite
  // Student-t. The day-lag γ̂ only has pairs starting in the history's first
  // historyMs − 24 h, so blocks without them drop out of that arm's df — which
  // is the honest count: a day-lag is known from as many days as the history has.
  const B = 8;
  const familyAlpha = familyWiseAlpha(baseZ);
  const maxLag = D + 2 * K;
  type Pts = Array<[number, number]>;
  /** Σ w·γ(i − j) over a point set. */
  const toSet = (gg: Float64Array, i: number, S: Pts): number => {
    let s = 0;
    for (const [j, w] of S) s += w * gg[Math.abs(i - j)];
    return s;
  };
  /** ΣΣ wᵢwⱼγ(i − j) between two point sets. */
  const between = (gg: Float64Array, S: Pts, T: Pts): number => {
    let s = 0;
    for (const [i, w] of S) s += w * toSet(gg, i, T);
    return s;
  };

  for (const t of trials) {
    const O = Math.round((t.obsFrom - origin) / W);
    if (O - H < 0 || O - D - K < 0 || overlapsGap(stream.gaps, t.obsFrom - DAY_MS - opts.spanMs, t.obsTo - DAY_MS)) {
      extraBlind++;
      continue;
    }
    // γ̂ at the lags these contrasts reach, from the history before the observation — whole and per block.
    const blockLen = H / B;
    const gamma = new Float64Array(maxLag + 1).fill(NaN);
    const gammaB = Array.from({ length: B }, () => new Float64Array(maxLag + 1).fill(NaN));
    gamma[0] = 0;
    for (const gb of gammaB) gb[0] = 0;
    const bs = new Float64Array(B);
    const bc = new Float64Array(B);
    for (const h of lagList) {
      let s = 0;
      let c = 0;
      bs.fill(0);
      bc.fill(0);
      for (let a = O - H; a + h < O; a++) {
        const ma = m[a];
        const mb = m[a + h];
        if (Number.isNaN(ma) || Number.isNaN(mb)) continue;
        const term = 0.5 * (ma - mb) ** 2 - 0.5 * (v[a] + v[a + h]);
        s += term;
        c++;
        const b = Math.min(B - 1, Math.floor((a - (O - H)) / blockLen));
        bs[b] += term;
        bc[b]++;
      }
      if (c > 0) gamma[h] = Math.max(0, s / c);
      for (let b = 0; b < B; b++) if (bc[b] > 0) gammaB[b][h] = Math.max(0, bs[b] / bc[b]);
    }
    const versions = [gamma, ...gammaB];
    const pooled = (from: number): Pts => {
      let N = 0;
      for (let i = from; i < from + K; i++) if (!Number.isNaN(m[i])) N += n[i];
      const ws: Pts = [];
      if (N > 0) for (let i = from; i < from + K; i++) if (!Number.isNaN(m[i])) ws.push([i, n[i] / N]);
      return ws;
    };
    const P = pooled(O - K);
    const Y = pooled(O - D);
    const Q = pooled(O - D - K);
    const wv = (S: Pts): number => S.reduce((s, [i, w]) => s + w * w * v[i], 0);
    const wm = (S: Pts, f: (i: number) => number): number => S.reduce((s, [i, w]) => s + w * f(i), 0);
    // The fixed sets' self and cross terms, once per trial and γ version.
    const PP = versions.map((gg) => between(gg, P, P));
    const YY = versions.map((gg) => between(gg, Y, Y));
    const QQ = versions.map((gg) => between(gg, Q, Q));
    const PQ = versions.map((gg) => between(gg, P, Q));
    const hourBin = new Date(t.obsFrom + HOUR_MS / 2).getUTCHours();
    const delta = opts.injectDelta ?? 0;
    const mean = (i: number): number => (delta !== 0 && i >= O + K / 2 && i < O + K ? m[i] + delta : m[i]);

    for (const arm of out) {
      // latent per γ version (index 0 = the whole history), sampling, estimate.
      const cs: Array<{ est: number; sampling: number; latent: number[] }> = [];
      for (let o = O; o < O + K; o++) {
        if (Number.isNaN(m[o])) { arm.unscored++; continue; }
        let est: number;
        let sampling: number;
        let latent: number[];
        if (arm.reference === "preceding") {
          if (P.length === 0) { arm.unscored++; continue; }
          est = mean(o) - wm(P, mean);
          sampling = v[o] + wv(P);
          latent = versions.map((gg, k) => 2 * toSet(gg, o, P) - PP[k]);
        } else if (arm.reference === "previous-day") {
          if (Y.length === 0) { arm.unscored++; continue; }
          est = mean(o) - wm(Y, mean);
          sampling = v[o] + wv(Y);
          latent = versions.map((gg, k) => 2 * toSet(gg, o, Y) - YY[k]);
        } else {
          const b = o - D;
          if (P.length === 0 || Q.length === 0 || Number.isNaN(m[b])) { arm.unscored++; continue; }
          // λ = e_o − P − e_b + Q:  −λᵀΓλ = −PP − QQ + 2oP + 2ob − 2oQ − 2Pb + 2PQ + 2bQ
          est = mean(o) - wm(P, mean) - m[b] + wm(Q, mean);
          sampling = v[o] + wv(P) + v[b] + wv(Q);
          latent = versions.map((gg, k) =>
            -PP[k] - QQ[k] + 2 * toSet(gg, o, P) + 2 * gg[D] - 2 * toSet(gg, o, Q) - 2 * toSet(gg, b, P) + 2 * PQ[k] + 2 * toSet(gg, b, Q));
        }
        if (Number.isNaN(latent[0]) || !(Math.max(0, latent[0]) + sampling > 0)) { arm.unscored++; continue; }
        cs.push({ est, sampling, latent });
      }
      if (cs.length === 0) continue;

      // Degrees of freedom for the latent part, from the blocks' mean contrast variance.
      const vbar = cs.reduce((s, c) => s + Math.max(0, c.latent[0]), 0) / cs.length;
      const vb: number[] = [];
      for (let k = 1; k <= B; k++) {
        const xs = cs.map((c) => c.latent[k]);
        if (xs.every((x) => Number.isFinite(x))) vb.push(xs.reduce((s, x) => s + Math.max(0, x), 0) / xs.length);
      }
      let nu = 1;
      if (vb.length >= 2) {
        const mb = vb.reduce((s, x) => s + x, 0) / vb.length;
        const s2 = vb.reduce((s, x) => s + (x - mb) ** 2, 0) / (vb.length - 1);
        nu = s2 > 0 ? (2 * vb.length * vbar * vbar) / s2 : Infinity;
      }

      // Two-sided tail per window against the Šidák per-window budget.
      const perWindow = 1 - (1 - familyAlpha) ** (1 / cs.length);
      let alarm = false;
      for (const c of cs) {
        const lat = Math.max(0, c.latent[0]);
        const z = Math.abs(c.est) / Math.sqrt(lat + c.sampling);
        const df = lat > 0 && Number.isFinite(nu) ? (lat + c.sampling) ** 2 / (lat ** 2 / nu) : Infinity;
        const tail = df > 1e6 ? familyWiseAlpha(z) : 2 * studentUpperTail(z, df);
        if (tail <= perWindow) { alarm = true; break; }
      }
      const bin = arm.arms[hourBin];
      bin.trials++;
      if (alarm) bin.flagged++;
    }
  }

  return out.map((arm) => {
    const bins = arm.arms.map((a, hour): DiurnalBin => ({
      hour, trials: a.trials, flagged: a.flagged, rate: a.trials > 0 ? a.flagged / a.trials : 0,
      level: level[hour], slope: Math.abs(level[hour] - level[(hour + 23) % 24]),
    }));
    const used = bins.filter((b) => b.trials > 0 && Number.isFinite(b.slope));
    return {
      reference: arm.reference,
      bins,
      correlation: pearson(used.map((b) => b.rate), used.map((b) => b.slope)),
      blindByGap: blind + extraBlind,
      unusableReference: 0,
      designTarget: familyWiseAlpha(baseZ),
      trials: bins.reduce((s, b) => s + b.trials, 0),
      flagged: bins.reduce((s, b) => s + b.flagged, 0),
      unscoredWindows: arm.unscored,
    };
  });
}

// ── Variogram null: trials on one grid, with history ───────────────────────

/** A recorded stream windowed once (windowedStream). */
export interface WindowedStream {
  /** The windows lying wholly inside [from, to), as a LensResult (groups included when the lens has them). */
  slice(from: number, to: number): LensResult;
}

/**
 * A recorded stream windowed ONCE, on one grid anchored at its first event, so
 * a trial's observation, reference and history (CurationContext.history, the
 * variogram null's) are slices of the same windows: the lags the null reads
 * are exact, and a day of history costs a slice instead of a re-aggregation
 * per trial. Windows touching a collection gap are dropped — blind, not data.
 */
export function windowedStream(stream: LoadedStream, lens: QObserveParams): WindowedStream {
  const origin = stream.events.length > 0 ? stream.events[0].ts : 0;
  const full = applyLens(stream.events, { ...lens, origin });
  const seen = (ws: WindowStat[]): WindowStat[] => ws.filter((w) => !overlapsGap(stream.gaps, w.windowStart, w.windowEnd));
  const windows = seen(full.windows);
  const groups = full.groups?.map((g) => ({ ...g, windows: seen(g.windows) }));
  const cut = (ws: WindowStat[], from: number, to: number): WindowStat[] => {
    const out: WindowStat[] = [];
    for (let i = lowerBound(ws, from, windowStartOf); i < ws.length && ws[i].windowStart < to; i++) if (ws[i].windowEnd <= to) out.push(ws[i]);
    return out;
  };
  return {
    slice: (from, to) => ({
      window_ms: full.window_ms,
      windows: cut(windows, from, to),
      ...(groups !== undefined ? { groups: groups.map((g) => ({ ...g, windows: cut(g.windows, from, to) })) } : {}),
    }),
  };
}

/** windowedStream, refusing trial spans that would cut windows (span and stride must be multiples of window_ms). */
function gridFor(stream: LoadedStream, lens: QObserveParams, spanMs: number, strideMs: number): WindowedStream {
  const w = lens.window_ms ?? 1_000;
  if (spanMs % w !== 0 || strideMs % w !== 0) {
    throw new RangeError(`span ${spanMs} ms and stride ${strideMs} ms must be multiples of window_ms ${w} to share one grid`);
  }
  return windowedStream(stream, lens);
}

function curateOnGrid(curator: SnapshotCurator, grid: WindowedStream, t: TrialPlan, historyMs: number): SnapshotPackage {
  return curator.curate(grid.slice(t.obsFrom, t.obsTo), grid.slice(t.refFrom, t.obsFrom), {
    ...(historyMs > 0 ? { history: grid.slice(t.refFrom - historyMs, t.obsFrom) } : {}),
  });
}

/** The grid a history is read from: windows touching a gap or an `exclude` span are left out. */
function historyGrid(stream: LoadedStream, lens: QObserveParams, exclude: readonly GapSpan[]): WindowedStream {
  return windowedStream({ ...stream, gaps: [...stream.gaps, ...exclude] }, lens);
}

/**
 * curateOnGrid with the history from its own grid (`hist`). `obs` overrides the
 * observation span when it does not follow the reference directly (flag
 * detection skips the settle tail after the edge).
 */
function curateWithHistory(
  curator: SnapshotCurator, grid: WindowedStream, hist: WindowedStream, t: TrialPlan, historyMs: number,
  obs: { obsFrom: number; obsTo: number } = t,
): SnapshotPackage {
  return curator.curate(grid.slice(obs.obsFrom, obs.obsTo), grid.slice(t.refFrom, t.obsFrom), {
    ...(historyMs > 0 ? { history: hist.slice(t.refFrom - historyMs, t.obsFrom) } : {}),
  });
}

export interface PositionProfile {
  trials: number;
  flagged: number;
  rate: number;
  /** Packages carrying a step tile. */
  stepPackages: number;
  unusableReference: number;
  blindByGap: number;
  designTarget: number;
  /**
   * Spike/dip tiles per trial-window, by where the window sits in the
   * observation span, in `bins` equal parts (first = next to the reference).
   * Flat under a null that is right about how the latent rate drifts; rising
   * when the comparison's variance grows with lag faster than the null allows
   * (ROADMAP_BRIEF.md 2026-10-14 (4)).
   */
  perWindowByPosition: number[];
}

/**
 * "Preceding span as reference" trials on one grid, scored with `curator` and
 * — when `historyMs` > 0 — that much history before each reference, with the
 * alarms resolved by position in the observation span. Every null model can
 * be run through it on identical windows, so their figures differ by the
 * null alone.
 */
export function runPositionProfile(
  stream: LoadedStream,
  opts: HarnessOptions & { historyMs?: number; bins?: number; obsFromTs?: number },
): PositionProfile {
  const spanMs = opts.spanMs ?? 10_000;
  const strideMs = opts.strideMs ?? 2 * spanMs;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  const windowMs = lens.window_ms ?? 1_000;
  const K = spanMs / windowMs;
  const bins = Math.min(K, opts.bins ?? 6);
  const grid = gridFor(stream, lens, spanMs, strideMs);
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const arm = tally();
  let stepPackages = 0;
  const tiles = new Array<number>(K).fill(0);
  for (const t of trials) {
    const pkg = curateOnGrid(curator, grid, t, opts.historyMs ?? 0);
    scoreInto(arm, pkg);
    if (!pkg.referenceUsable) continue;
    if (pkg.tiles.some((x) => x.shapeTag === "step_up" || x.shapeTag === "step_down")) stepPackages++;
    for (const x of pkg.tiles) {
      if (x.shapeTag !== "spike" && x.shapeTag !== "dip") continue;
      tiles[Math.min(K - 1, Math.max(0, Math.floor((x.regionStart - t.obsFrom) / windowMs)))]++;
    }
  }
  const perWindowByPosition = Array.from({ length: bins }, (_, b) => {
    const from = Math.round((b * K) / bins);
    const to = Math.round(((b + 1) * K) / bins);
    let n = 0;
    for (let i = from; i < to; i++) n += tiles[i];
    return arm.trials > 0 ? n / (arm.trials * (to - from)) : 0;
  });
  return {
    trials: arm.trials, flagged: arm.flagged, rate: arm.trials > 0 ? arm.flagged / arm.trials : 0, stepPackages,
    unusableReference: arm.unusableReference, blindByGap: blind, designTarget: familyWiseAlpha(baseZ), perWindowByPosition,
  };
}

// ── Calibration by volume, and detection at steady volume (2026-10-22 (5)) ──

/**
 * The band of `volumeRatio` (window count ÷ the reference's median window count)
 * read as ordinary volume — 2026-10-14 (7)'s band. Outside it, the window's
 * volume moved with its rate: the stream's make-up changed (a bot batch starting
 * or stopping), a real event by that decision, not a null to calibrate against.
 * Only meaningful where the band is several Poisson SDs wide (10 s and 60 s
 * windows on this stream, not 1 s ones); reports print the width.
 */
export const ORDINARY_VOLUME: readonly [number, number] = ORDINARY_VOLUME_BAND;

/** A curator like the reports' (curatorForNullModel / newCurator) that also records every window's score. */
export function scoringCurator(
  nullModel: "independent" | "overdispersed" | "variogram", baseZ = 2.0, sensitivityPower?: number, volumeChannel?: boolean,
): SnapshotCurator {
  return new SnapshotCurator({
    spikeZThreshold: baseZ, includeBaseline: true, maxTiles: HARNESS_MAX_TILES, recordWindowScores: true,
    ...(nullModel === "independent" ? {} : { nullModel }),
    ...(sensitivityPower !== undefined ? { sensitivityPower } : {}),
    ...(volumeChannel ? { volumeChannel } : {}),
  });
}

export interface VolumeBandStats {
  band: "ordinary" | "low" | "high";
  /** (trial, window) pairs: overlapping trials score one window against several references. */
  windows: number;
  meanGateZ: number;
  varGateZ: number;
  /** Share with |gateZ| ≥ 1, 2, 3 (N(0, 1): 31.7%, 4.55%, 0.27%) and ≥ the package's own gate. */
  over1: number;
  over2: number;
  over3: number;
  overGate: number;
  /** overGate under a calibrated null: the mean per-window two-sided alpha of the gates applied. */
  nominalOverGate: number;
  /** The raw sums the figures above come from, so runs can be pooled exactly. */
  sums: GateZSums;
}

/** VolumeBandStats' figures from its sums. */
export function bandFigures(band: VolumeBandStats["band"], a: GateZSums): VolumeBandStats {
  const mean = a.n > 0 ? a.s / a.n : 0;
  return {
    band, windows: a.n, meanGateZ: mean, varGateZ: a.n > 1 ? (a.ss - a.n * mean * mean) / (a.n - 1) : 0,
    over1: a.n > 0 ? a.o1 / a.n : 0, over2: a.n > 0 ? a.o2 / a.n : 0, over3: a.n > 0 ? a.o3 / a.n : 0,
    overGate: a.n > 0 ? a.og / a.n : 0, nominalOverGate: a.n > 0 ? a.alpha / a.n : 0, sums: { ...a },
  };
}

/** Pool b into a (exact: the sums add). */
export function addGateZSums(a: GateZSums, b: GateZSums): void {
  a.n += b.n;
  a.s += b.s;
  a.ss += b.ss;
  a.o1 += b.o1;
  a.o2 += b.o2;
  a.o3 += b.o3;
  a.og += b.og;
  a.alpha += b.alpha;
}

/** Running sums of the gate's z over a set of (trial, window) pairs. */
export interface GateZSums {
  n: number;
  /** Σz and Σz². */
  s: number;
  ss: number;
  /** Pairs with |z| ≥ 1, ≥ 2, ≥ 3, and ≥ the package's own gate. */
  o1: number;
  o2: number;
  o3: number;
  og: number;
  /** Σ of the per-window two-sided alpha of the gates applied (the nominal count for `og`). */
  alpha: number;
}

export const emptyGateZSums = (): GateZSums => ({ n: 0, s: 0, ss: 0, o1: 0, o2: 0, o3: 0, og: 0, alpha: 0 });

export interface VolumeCalibrationDay {
  day: string;
  trials: number;
  flagged: number;
  flaggedOrdinary: number;
  episodes: number;
  compositionEpisodes: number;
  /** The gate's z at ordinary volume that day — for day-to-day spread (a day is the resampling unit). */
  ordinary: GateZSums;
  /** With a volume-channel curator: trials whose volume channel had a tile, and its z over every window that day. */
  volumeFlagged?: number;
  volumeZ?: GateZSums;
  /** Of that day's compositionEpisodes (by the episode's first trial), those the volume channel also flagged. */
  compositionCaught?: number;
}

/** What the volume channel (CurationOptions.volumeChannel) did over the same trials — present only when the curator had it on. */
export interface VolumeChannelFigures {
  /** Scored trials whose volume channel was blind (too few reference windows) and so judged nothing. */
  blindTrials: number;
  /** Trials with a volume tile, in either direction. */
  flagged: number;
  /** The channel's z over every (trial, window) pair against N(0, 1); `og` counts pairs past its own gate. */
  z: GateZSums;
  /** Fired windows by direction. */
  up: number;
  down: number;
  /** Runs of volume-flagged trials one stride apart — the independent units its alarm rate is made of. */
  episodes: number;
  /** Rate-alarm episodes (above) that were composition-only, and how many of those the volume channel also flagged in some trial of the episode. */
  compositionEpisodes: number;
  compositionEpisodesCaught: number;
  /** Rate-alarm episodes with a fired window at ordinary volume, and how many of those the volume channel also flagged. */
  ordinaryEpisodes: number;
  ordinaryEpisodesCaught: number;
  /** Packages where the rate gate fired at ordinary volume while the volume channel also fired in the same trial. */
  ordinaryRateWithVolume: number;
}

export interface VolumeCalibrationResult {
  trials: number;
  unusableReference: number;
  blindByGap: number;
  /** Packages with any statistical tile — the alarm every earlier figure counted. */
  flagged: number;
  /** Packages whose gate fired on a window of ordinary volume. */
  flaggedOrdinary: number;
  /** flaggedOrdinary / trials under a calibrated null: the mean over trials of 1 − (1 − α′)^(ordinary windows scored). */
  expectedOrdinaryRate: number;
  bands: VolumeBandStats[];
  /** Runs of alarming trials one stride apart — the independent units the alarm rate is made of. */
  episodes: number;
  /** Episodes in which the gate fired, and fired only on windows off ordinary volume. */
  compositionEpisodes: number;
  byDay: VolumeCalibrationDay[];
  /** Median count of the scored windows' reference median — what the band's width in Poisson SDs is read from. */
  typicalWindowCount: number;
  designTarget: number;
  /** Present only when the curator had the volume channel on. */
  volume?: VolumeChannelFigures;
}

/**
 * "Preceding span as reference" trials (runPositionProfile's) with the gate's
 * score recorded for EVERY window and split by volume. Two questions the
 * package alarm rate alone cannot tell apart on unlabelled real data
 * (ROADMAP_BRIEF.md 2026-10-22 (4)): is the predictive distribution right where
 * the null's assumptions hold (ordinary volume: the bulk and the tail of gateZ
 * against N(0, 1), and the ordinary-volume package rate against what the gate
 * promises for that many windows) — and how much of the alarm rate is the
 * stream's make-up changing (episodes whose fired windows all moved in volume).
 * `curator` must record window scores (scoringCurator).
 */
export function runVolumeCalibration(
  stream: LoadedStream,
  opts: HarnessOptions & { historyMs?: number; obsFromTs?: number; band?: readonly [number, number] },
): VolumeCalibrationResult {
  const spanMs = opts.spanMs ?? 10_000;
  const strideMs = opts.strideMs ?? 2 * spanMs;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator;
  if (curator === undefined) throw new RangeError("runVolumeCalibration needs a curator that records window scores (scoringCurator)");
  const [lo, hi] = opts.band ?? ORDINARY_VOLUME;
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  const grid = gridFor(stream, lens, spanMs, strideMs);
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const acc = new Map<VolumeBandStats["band"], GateZSums>();
  for (const b of ["ordinary", "low", "high"] as const) acc.set(b, emptyGateZSums());
  const bandOf = (r: number): VolumeBandStats["band"] => (r < lo ? "low" : r > hi ? "high" : "ordinary");
  const out: VolumeCalibrationResult = {
    trials: 0, unusableReference: 0, blindByGap: blind, flagged: 0, flaggedOrdinary: 0, expectedOrdinaryRate: 0,
    bands: [], episodes: 0, compositionEpisodes: 0, byDay: [], typicalWindowCount: 0, designTarget: familyWiseAlpha(baseZ),
  };
  const days = new Map<string, VolumeCalibrationDay>();
  const typical: number[] = [];
  let expectedSum = 0;
  // The open episode: the last alarming trial's obsFrom, and whether any of its fired windows sat at ordinary volume.
  let open: { last: number; day: VolumeCalibrationDay; anyFired: boolean; anyOrdinary: boolean; anyVolume: boolean } | undefined;
  let vfig: VolumeChannelFigures | undefined;
  let openVolume: number | undefined; // the last volume-flagged trial's obsFrom
  const closeEpisode = () => {
    if (open === undefined) return;
    out.episodes++;
    open.day.episodes++;
    if (open.anyFired && !open.anyOrdinary) {
      out.compositionEpisodes++;
      open.day.compositionEpisodes++;
      if (vfig !== undefined) {
        vfig.compositionEpisodes++;
        if (open.anyVolume) {
          vfig.compositionEpisodesCaught++;
          open.day.compositionCaught = (open.day.compositionCaught ?? 0) + 1;
        }
      }
    } else if (open.anyOrdinary && vfig !== undefined) {
      vfig.ordinaryEpisodes++;
      if (open.anyVolume) vfig.ordinaryEpisodesCaught++;
    }
    open = undefined;
  };
  for (const t of trials) {
    const pkg = curateOnGrid(curator, grid, t, opts.historyMs ?? 0);
    if (!pkg.referenceUsable) {
      out.unusableReference++;
      continue;
    }
    const scores = pkg.windowScores;
    if (scores === undefined) throw new RangeError("runVolumeCalibration: the curator did not record window scores (scoringCurator)");
    const dayKey = new Date(t.obsFrom).toISOString().slice(0, 10);
    let day = days.get(dayKey);
    if (day === undefined) {
      days.set(dayKey, (day = { day: dayKey, trials: 0, flagged: 0, flaggedOrdinary: 0, episodes: 0, compositionEpisodes: 0, ordinary: emptyGateZSums() }));
    }
    out.trials++;
    day.trials++;
    const gateAt = pkg.selection.effectiveZThreshold;
    const alpha = familyWiseAlpha(gateAt);
    let ordinaryWindows = 0;
    let firedOrdinary = false;
    let fired = false;
    for (const s of scores) {
      if (!Number.isFinite(s.volumeRatio)) continue;
      const band = bandOf(s.volumeRatio);
      const g = Math.abs(s.gateZ);
      for (const a of band === "ordinary" ? [acc.get(band)!, day.ordinary] : [acc.get(band)!]) {
        a.n++;
        a.s += s.gateZ;
        a.ss += s.gateZ * s.gateZ;
        if (g >= 1) a.o1++;
        if (g >= 2) a.o2++;
        if (g >= 3) a.o3++;
        if (g >= gateAt) a.og++;
        a.alpha += alpha;
      }
      if (g >= gateAt) {
        fired = true;
        if (band === "ordinary") firedOrdinary = true;
      }
      if (band === "ordinary") ordinaryWindows++;
      typical.push(s.count / s.volumeRatio);
    }
    expectedSum += 1 - Math.pow(1 - alpha, ordinaryWindows);
    let volumeFired = false;
    if (pkg.volume !== undefined) {
      const vol = pkg.volume;
      vfig ??= {
        blindTrials: 0, flagged: 0, z: emptyGateZSums(), up: 0, down: 0, episodes: 0,
        compositionEpisodes: 0, compositionEpisodesCaught: 0, ordinaryEpisodes: 0, ordinaryEpisodesCaught: 0, ordinaryRateWithVolume: 0,
      };
      day.volumeZ ??= emptyGateZSums();
      day.volumeFlagged ??= 0;
      if (vol.units.every((u) => u.blind)) vfig.blindTrials++;
      const vAlpha = familyWiseAlpha(vol.effectiveZThreshold);
      for (const s of vol.scores ?? []) {
        const g = Math.abs(s.gateZ);
        for (const a of [vfig.z, day.volumeZ]) {
          a.n++;
          a.s += s.gateZ;
          a.ss += s.gateZ * s.gateZ;
          if (g >= 1) a.o1++;
          if (g >= 2) a.o2++;
          if (g >= 3) a.o3++;
          if (g >= vol.effectiveZThreshold) a.og++;
          a.alpha += vAlpha;
        }
      }
      for (const tl of vol.tiles) {
        if (tl.direction === "up") vfig.up++;
        else vfig.down++;
      }
      volumeFired = vol.tiles.length > 0;
      if (volumeFired) {
        vfig.flagged++;
        day.volumeFlagged++;
        if (openVolume === undefined || t.obsFrom - openVolume !== strideMs) vfig.episodes++;
        openVolume = t.obsFrom;
        if (firedOrdinary) vfig.ordinaryRateWithVolume++;
      }
    }
    const alarm = statisticalTiles(pkg).length > 0;
    if (alarm) {
      out.flagged++;
      day.flagged++;
    }
    if (firedOrdinary) {
      out.flaggedOrdinary++;
      day.flaggedOrdinary++;
    }
    if (alarm) {
      if (open !== undefined && t.obsFrom - open.last !== strideMs) closeEpisode();
      if (open === undefined) open = { last: t.obsFrom, day, anyFired: false, anyOrdinary: false, anyVolume: false };
      open.last = t.obsFrom;
      open.anyFired ||= fired;
      open.anyOrdinary ||= firedOrdinary;
      open.anyVolume ||= volumeFired;
    } else {
      closeEpisode();
    }
  }
  closeEpisode();
  if (vfig !== undefined) out.volume = vfig;
  out.expectedOrdinaryRate = out.trials > 0 ? expectedSum / out.trials : 0;
  out.bands = [...acc.entries()].map(([band, a]) => bandFigures(band, a));
  out.byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  typical.sort((a, b) => a - b);
  out.typicalWindowCount = typical.length > 0 ? typical[typical.length >> 1] : 0;
  return out;
}

/**
 * `shift` added to a binary, unweighted window's mean by flipping whole events
 * (0 → 1 for a positive shift, 1 → 0 for a negative one) — the window's count,
 * i.e. its volume, is unchanged. Undefined when the window is not 0/1 data, is
 * weighted, or has too few events on the side to flip.
 */
export function shiftBinaryWindow(w: WindowStat, shift: number): { window: WindowStat; shift: number } | undefined {
  if (w.weights !== undefined || w.aggFunc !== undefined || !(w.count > 0)) return undefined;
  const ones = Math.round(w.mean * w.count);
  if (Math.abs(ones - w.mean * w.count) > 1e-6 || Math.abs(w.sumSq - ones) > 1e-6) return undefined;
  const k = Math.round(Math.abs(shift) * w.count);
  const after = shift < 0 ? ones - k : ones + k;
  if (after < 0 || after > w.count) return undefined;
  return {
    window: {
      ...w, mean: after / w.count, sumSq: after,
      ...(w.range !== undefined ? { range: { min: after < w.count ? 0 : 1, max: after > 0 ? 1 : 0 } } : {}),
    },
    shift: (after - ones) / w.count,
  };
}

export interface ShiftInjectionResult {
  trials: number;
  /** A statistical tile on the shifted windows, in the shift's direction. */
  detected: number;
  power: number;
  /** The same trials with nothing planted: tiles on those windows in that direction. */
  controlDetected: number;
  controlRate: number;
  /** Mean shift actually planted (whole events), over scored trials. */
  meanShiftTruth: number;
  /** Trials whose shifted windows were missing, unscorable, or short of events to flip. */
  skipped: number;
  unusableReference: number;
  blindByGap: number;
}

/**
 * Measurement ② for the "preceding span" trials on one grid (the variogram
 * null's trials, with history): plant a sustained shift of the window mean,
 * at steady volume, into the first `windows` windows of each observation — the
 * trial whose reference ends where the change begins, the way runFlagDetection
 * reads a fault's edge — and see whether the curator names it. The same trials
 * scored unplanted give the control. The history ends where the reference does,
 * so the plant never widens its own yardstick. Mixed (ungrouped) lens only.
 */
export function runShiftInjection(
  stream: LoadedStream,
  opts: HarnessOptions & { historyMs?: number; obsFromTs?: number; shift: number; windows: number; every?: number },
): ShiftInjectionResult {
  const spanMs = opts.spanMs ?? 10_000;
  const strideMs = opts.strideMs ?? 2 * spanMs;
  const curator = opts.curator ?? newCurator(opts.baseZThreshold ?? 2.0);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  if ((lens.group_by ?? []).length > 0) throw new RangeError("runShiftInjection plants into the mixed stream; a grouped lens is not supported");
  const windowMs = lens.window_ms ?? 1_000;
  const every = Math.max(1, Math.floor(opts.every ?? 1));
  const grid = gridFor(stream, lens, spanMs, strideMs);
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const out: ShiftInjectionResult = {
    trials: 0, detected: 0, power: 0, controlDetected: 0, controlRate: 0, meanShiftTruth: 0, skipped: 0, unusableReference: 0, blindByGap: blind,
  };
  const tags = opts.shift < 0 ? new Set(["dip", "step_down"]) : new Set(["spike", "step_up"]);
  let truth = 0;
  for (let k = 0; k < trials.length; k += every) {
    const t = trials[k];
    const from = t.obsFrom;
    const to = t.obsFrom + opts.windows * windowMs;
    const obs = grid.slice(t.obsFrom, t.obsTo);
    const ref = grid.slice(t.refFrom, t.obsFrom);
    const context = (opts.historyMs ?? 0) > 0 ? { history: grid.slice(t.refFrom - (opts.historyMs ?? 0), t.obsFrom) } : {};
    const target = obs.windows.filter((w) => w.windowStart >= from && w.windowStart < to);
    const planted = target.map((w) => shiftBinaryWindow(w, opts.shift));
    if (target.length < opts.windows || !target.every(isScorable) || planted.some((p) => p === undefined)) {
      out.skipped++;
      continue;
    }
    const swap = new Map(target.map((w, i) => [w, planted[i]!.window]));
    const pkg = curator.curate({ ...obs, windows: obs.windows.map((w) => swap.get(w) ?? w) }, ref, context);
    if (!pkg.referenceUsable) {
      out.unusableReference++;
      continue;
    }
    const control = curator.curate(obs, ref, context);
    const hit = (p: SnapshotPackage) => statisticalTiles(p).some((x) => tags.has(x.shapeTag) && x.regionStart < to && x.regionEnd > from);
    out.trials++;
    truth += planted.reduce((s, p) => s + p!.shift, 0) / planted.length;
    if (hit(pkg)) out.detected++;
    if (hit(control)) out.controlDetected++;
  }
  out.power = out.trials > 0 ? out.detected / out.trials : 0;
  out.controlRate = out.trials > 0 ? out.controlDetected / out.trials : 0;
  out.meanShiftTruth = out.trials > 0 ? truth / out.trials : 0;
  return out;
}

// ── Step 1 (2026-11-02 (2)): what the gate can see, and what the history does to it ──

export interface SensitivityCheckResult {
  direction: "dip" | "spike";
  /** The detection probability the package quoted its shifts at. */
  power: number;
  /** Trials planted with the package's own predicted shift and scored. */
  trials: number;
  detected: number;
  /** Should sit near `power` when the package's sensitivity is right. */
  detectionRate: number;
  /** The same trials unplanted: tiles on the target window in that direction. */
  controlDetected: number;
  controlRate: number;
  /** Mean predicted shift (the target window's MDE) and the mean shift actually planted (random flips), over scored trials. */
  meanMde: number;
  meanPlanted: number;
  /** Detection split by the realized shift relative to its MDE (random flips scatter it): [lo, hi) → trials, detected. */
  byPlantedRatio: Array<{ lo: number; hi: number; trials: number; detected: number }>;
  /** The target window's MDE was null in this direction (the data's range ends first). */
  unreachable: number;
  /** Target window missing, unscorable, or short of events to flip. */
  skipped: number;
  unusableReference: number;
  blindByGap: number;
}

/**
 * A latent-rate shift planted into a binary, unweighted window at steady
 * volume: each event at 1 turns to 0 with probability δ / `rate` (a dip), or
 * each event at 0 turns to 1 with probability δ / (1 − `rate`) (a spike), so
 * every event's chance of sitting at 1 moves by about δ — the alternative a
 * package's sensitivity is quoted for (CurationOptions.sensitivityPower) —
 * rather than shiftBinaryWindow's fixed number of flipped events. `rate` is
 * the reference's share; undefined when the window is not 0/1 data or the
 * shift does not fit.
 */
export function flipBinaryWindow(w: WindowStat, shift: number, rate: number, rng: () => number): { window: WindowStat; shift: number } | undefined {
  if (w.weights !== undefined || w.aggFunc !== undefined || !(w.count > 0)) return undefined;
  const ones = Math.round(w.mean * w.count);
  if (Math.abs(ones - w.mean * w.count) > 1e-6 || Math.abs(w.sumSq - ones) > 1e-6) return undefined;
  const q = shift < 0 ? -shift / rate : shift / (1 - rate);
  if (!(q >= 0 && q <= 1)) return undefined;
  let flipped = 0;
  const pool = shift < 0 ? ones : w.count - ones;
  for (let i = 0; i < pool; i++) if (rng() < q) flipped++;
  const after = shift < 0 ? ones - flipped : ones + flipped;
  return {
    window: {
      ...w, mean: after / w.count, sumSq: after,
      ...(w.range !== undefined ? { range: { min: after < w.count ? 0 : 1, max: after > 0 ? 1 : 0 } } : {}),
    },
    shift: (after - ones) / w.count,
  };
}

const PLANTED_RATIO_BINS: ReadonlyArray<readonly [number, number]> = [[0, 0.9], [0.9, 0.97], [0.97, 1.03], [1.03, 1.1], [1.1, Infinity]];

/**
 * Measure the package's own sensitivity claim (CurationOptions.sensitivityPower)
 * against planted shifts: in each "preceding span" trial, take one observation
 * window (rotating through the positions, so a variogram null's growth with
 * distance is sampled), read the MDE the package quotes for it, plant exactly
 * that shift at steady volume (flipBinaryWindow: each event flipped at random
 * so the window's latent rate moves by the MDE, count kept) and see whether
 * the gate catches it. If the quoted shifts are right the
 * detection rate sits at the quoted power; the unplanted trials are the
 * control. The reference and history are untouched, so the plant never widens
 * its own yardstick. Mixed (ungrouped) lens on 0/1 data only.
 */
export function runSensitivityCheck(
  stream: LoadedStream,
  opts: HarnessOptions & {
    direction: "dip" | "spike";
    nullModel?: "independent" | "overdispersed" | "variogram";
    power?: number;
    historyMs?: number;
    obsFromTs?: number;
    every?: number;
  },
): SensitivityCheckResult {
  const spanMs = opts.spanMs ?? 10_000;
  const strideMs = opts.strideMs ?? 2 * spanMs;
  const power = opts.power ?? 0.8;
  const nullModel = opts.nullModel ?? "independent";
  if (nullModel === "variogram" && !((opts.historyMs ?? 0) > 0)) throw new RangeError("runSensitivityCheck: the variogram null needs historyMs");
  const curator = scoringCurator(nullModel, opts.baseZThreshold ?? 2.0, power);
  // The planted copy needs only its tiles, which sensitivity never changes.
  const plain = scoringCurator(nullModel, opts.baseZThreshold ?? 2.0);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  if ((lens.group_by ?? []).length > 0) throw new RangeError("runSensitivityCheck plants into the mixed stream; a grouped lens is not supported");
  const every = Math.max(1, Math.floor(opts.every ?? 1));
  const grid = gridFor(stream, lens, spanMs, strideMs);
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const out: SensitivityCheckResult = {
    direction: opts.direction, power, trials: 0, detected: 0, detectionRate: 0, controlDetected: 0, controlRate: 0,
    meanMde: 0, meanPlanted: 0, byPlantedRatio: PLANTED_RATIO_BINS.map(([lo, hi]) => ({ lo, hi, trials: 0, detected: 0 })),
    unreachable: 0, skipped: 0, unusableReference: 0, blindByGap: blind,
  };
  const dir = opts.direction === "dip" ? -1 : 1;
  const tags = dir < 0 ? new Set(["dip", "step_down"]) : new Set(["spike", "step_up"]);
  const rng = mulberry32(opts.seed ?? 1);
  let mdeSum = 0;
  let plantedSum = 0;
  let position = 0;
  for (let k = 0; k < trials.length; k += every) {
    const t = trials[k];
    const obs = grid.slice(t.obsFrom, t.obsTo);
    const ref = grid.slice(t.refFrom, t.obsFrom);
    const context = (opts.historyMs ?? 0) > 0 ? { history: grid.slice(t.refFrom - (opts.historyMs ?? 0), t.obsFrom) } : {};
    if (obs.windows.length === 0) {
      out.skipped++;
      continue;
    }
    const target = obs.windows[position++ % obs.windows.length];
    const control = curator.curate(obs, ref, context);
    if (!control.referenceUsable) {
      out.unusableReference++;
      continue;
    }
    const score = control.windowScores?.find((s) => s.windowStart === target.windowStart);
    if (score === undefined || score.mde === undefined) {
      out.skipped++;
      continue;
    }
    const mde = dir < 0 ? score.mde.dip : score.mde.spike;
    if (mde === null) {
      out.unreachable++;
      continue;
    }
    const planted = flipBinaryWindow(target, dir * mde, control.globalStats.mean, rng);
    if (planted === undefined) {
      out.skipped++;
      continue;
    }
    const pkg = plain.curate({ ...obs, windows: obs.windows.map((w) => (w === target ? planted.window : w)) }, ref, context);
    const hit = (p: SnapshotPackage) =>
      statisticalTiles(p).some((x) => tags.has(x.shapeTag) && x.regionStart < target.windowEnd && x.regionEnd > target.windowStart);
    const found = hit(pkg);
    out.trials++;
    mdeSum += mde;
    plantedSum += Math.abs(planted.shift);
    if (found) out.detected++;
    if (hit(control)) out.controlDetected++;
    const ratio = Math.abs(planted.shift) / mde;
    const bin = out.byPlantedRatio.find((b) => ratio >= b.lo && ratio < b.hi)!;
    bin.trials++;
    if (found) bin.detected++;
  }
  out.detectionRate = out.trials > 0 ? out.detected / out.trials : 0;
  out.controlRate = out.trials > 0 ? out.controlDetected / out.trials : 0;
  out.meanMde = out.trials > 0 ? mdeSum / out.trials : 0;
  out.meanPlanted = out.trials > 0 ? plantedSum / out.trials : 0;
  return out;
}

/** Each window's count over the median count of the `k` windows before it on the grid (NaN with fewer than k before it). */
export function trailingVolumeRatios(windows: readonly WindowStat[], k: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < windows.length; i++) {
    if (i < k) {
      out.set(windows[i].windowStart, NaN);
      continue;
    }
    const counts = windows.slice(i - k, i).map((w) => w.count).sort((a, b) => a - b);
    const median = counts[counts.length >> 1];
    out.set(windows[i].windowStart, median > 0 ? windows[i].count / median : NaN);
  }
  return out;
}

/**
 * Each window's count over the median count of the windows within `k` places on
 * either side of it on the grid, itself left out (NaN with fewer than 3 neighbours).
 * A make-up change shorter than about k windows stands out from both sides; a longer
 * one looks ordinary inside, and only its edges show. Looks at windows AFTER it, so it
 * reads a history (windows already ended), never an observation.
 */
export function centeredVolumeRatios(windows: readonly WindowStat[], k: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < windows.length; i++) {
    const near: number[] = [];
    for (let j = Math.max(0, i - k); j <= Math.min(windows.length - 1, i + k); j++) if (j !== i) near.push(windows[j].count);
    near.sort((a, b) => a - b);
    const median = near.length >= 3 ? near[near.length >> 1] : 0;
    out.set(windows[i].windowStart, median > 0 ? windows[i].count / median : NaN);
  }
  return out;
}

export interface HistoryMixBand {
  band: VolumeBandStats["band"];
  /** Gate z with the history as recorded. */
  full: VolumeBandStats;
  /** The same (trial, window) pairs with the history's off-ordinary-volume windows left out of γ̂. */
  cleaned: VolumeBandStats;
}

export interface HistoryMixBin {
  /** Share of the trial's history windows off ordinary volume: [from, to). */
  from: number;
  to: number;
  trials: number;
  /** Ordinary-volume observation windows only. */
  full: VolumeBandStats;
  cleaned: VolumeBandStats;
}

export interface HistoryMixResult {
  trials: number;
  unusableReference: number;
  blindByGap: number;
  /** Mean share of a trial's history windows off ordinary volume. */
  meanContamination: number;
  historyWindows: number;
  removedHistoryWindows: number;
  /** Every trial pooled, by the observation window's volume band. */
  bands: HistoryMixBand[];
  /** Ordinary-volume windows by how much of the trial's history was off ordinary volume. */
  bins: HistoryMixBin[];
  /** Ordinary-volume windows per observation day (UTC), so one day's make-up changes can be told from a week's. */
  byDay: Array<{ day: string; trials: number; meanContamination: number; full: VolumeBandStats; cleaned: VolumeBandStats }>;
  /** The steady-volume shift planted over the first `windows` observation windows, caught with either history. */
  injection?: { shift: number; windows: number; trials: number; detectedFull: number; detectedCleaned: number; controlFull: number; controlCleaned: number; skipped: number };
}

const CONTAMINATION_BINS: readonly number[] = [0, 0.02, 0.05, 0.1, 0.2, Infinity];

/**
 * Hypothesis H-mix (ROADMAP_BRIEF.md 2026-11-02 (2)): the variogram null is
 * conservative at ordinary volume (stage 4: var z 0.533) because γ̂ is read
 * with the classical estimator from a history that holds the stream's make-up
 * changing — windows whose volume moved with their rate — which inflates γ̂,
 * and so every ordinary window's yardstick.
 *
 * The test leaves the curator alone and changes only what it is handed: each
 * trial is scored twice, with the history as recorded and with the history's
 * windows off ordinary volume removed. "Off ordinary" has two readings
 * (`clean`):
 *   - "reference" (default): the window's count against the median count of
 *     THIS trial's reference windows — the yardstick an observation window's
 *     own band (WindowScore.volumeRatio) is read with, so γ̂ comes from windows
 *     whose make-up resembles the stream now. Also drops windows that differ
 *     only by the time of day, which is part of what is being asked;
 *   - "trailing": against the median of the `spanMs / window_ms` windows just
 *     before it on the grid. Catches only the edges of a make-up change: a
 *     batch longer than half a span looks ordinary to its own past (measured
 *     on synthetic batches, 2026-11-02 (2)).
 * If H-mix
 * holds, the ordinary-volume gate z is narrower than N(0, 1) when the history
 * is contaminated, and widens toward it when cleaned; if contamination makes
 * no difference, the conservatism is elsewhere. Removing windows from γ̂ is a
 * DIAGNOSTIC, not a proposed null: the heavy-tailed moves were kept in the
 * null on purpose (2026-10-14 (4)), and what cleaning costs shows up in the
 * off-ordinary bands. Mixed (ungrouped) lens only; the variogram null.
 */
export function runHistoryMixCalibration(
  stream: LoadedStream,
  opts: HarnessOptions & {
    historyMs: number;
    obsFromTs?: number;
    band?: readonly [number, number];
    clean?: "reference" | "trailing" | "history" | "centered";
    /** clean "history" only: cap on the removed share (cleanHistoryByMedian's maxRemovedShare); default none, to measure the rule uncapped. */
    maxRemovedShare?: number;
    /** Edges of the contamination bins (ascending, from 0, last Infinity); default CONTAMINATION_BINS. */
    contaminationBins?: readonly number[];
    inject?: { shift: number; windows: number; every?: number };
  },
): HistoryMixResult {
  const spanMs = opts.spanMs ?? 10_000;
  const strideMs = opts.strideMs ?? 2 * spanMs;
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  if ((lens.group_by ?? []).length > 0) throw new RangeError("runHistoryMixCalibration reads the mixed stream; a grouped lens is not supported");
  if (!(opts.historyMs > 0)) throw new RangeError("runHistoryMixCalibration needs historyMs (the variogram null reads a history)");
  const windowMs = lens.window_ms ?? 1_000;
  const [lo, hi] = opts.band ?? ORDINARY_VOLUME;
  const curator = scoringCurator("variogram", opts.baseZThreshold ?? 2.0);
  const grid = gridFor(stream, lens, spanMs, strideMs);
  const clean = opts.clean ?? "reference";
  const spanWindows = Math.max(1, Math.round(spanMs / windowMs));
  const ratios =
    clean === "trailing" ? trailingVolumeRatios(grid.slice(-Infinity, Infinity).windows, spanWindows)
    : clean === "centered" ? centeredVolumeRatios(grid.slice(-Infinity, Infinity).windows, spanWindows)
    : undefined;
  const offBand = (r: number | undefined): boolean => r !== undefined && Number.isFinite(r) && (r < lo || r > hi);
  const bandOf = (r: number): VolumeBandStats["band"] => (r < lo ? "low" : r > hi ? "high" : "ordinary");
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs, obsFromTs: opts.obsFromTs });
  const pooled = new Map<VolumeBandStats["band"], { full: GateZSums; cleaned: GateZSums }>();
  for (const b of ["ordinary", "low", "high"] as const) pooled.set(b, { full: emptyGateZSums(), cleaned: emptyGateZSums() });
  const edges = opts.contaminationBins ?? CONTAMINATION_BINS;
  const bins = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], trials: 0, full: emptyGateZSums(), cleaned: emptyGateZSums() }));
  const out: HistoryMixResult = {
    trials: 0, unusableReference: 0, blindByGap: blind, meanContamination: 0, historyWindows: 0, removedHistoryWindows: 0, bands: [], bins: [], byDay: [],
  };
  const days = new Map<string, { trials: number; contamination: number; full: GateZSums; cleaned: GateZSums }>();
  const inj = opts.inject;
  const injection = inj === undefined ? undefined : { shift: inj.shift, windows: inj.windows, trials: 0, detectedFull: 0, detectedCleaned: 0, controlFull: 0, controlCleaned: 0, skipped: 0 };
  const add = (a: GateZSums, z: number, gateAt: number, alpha: number) => {
    const g = Math.abs(z);
    a.n++;
    a.s += z;
    a.ss += z * z;
    if (g >= 1) a.o1++;
    if (g >= 2) a.o2++;
    if (g >= 3) a.o3++;
    if (g >= gateAt) a.og++;
    a.alpha += alpha;
  };
  let contaminationSum = 0;
  for (let k = 0; k < trials.length; k++) {
    const t = trials[k];
    const obs = grid.slice(t.obsFrom, t.obsTo);
    const ref = grid.slice(t.refFrom, t.obsFrom);
    const history = grid.slice(t.refFrom - opts.historyMs, t.obsFrom);
    const refCounts = ref.windows.map((w) => w.count).sort((a, b) => a - b);
    const refMedian = refCounts.length > 0 ? refCounts[refCounts.length >> 1] : 0;
    // "history": the shipped rule (comparison.ts), against the median of the whole history, not of this trial's reference.
    const kept = clean === "history"
      ? cleanHistoryByMedian(history, { band: [lo, hi], maxRemovedShare: opts.maxRemovedShare ?? Infinity }).history.windows
      : history.windows.filter((w) => !offBand(ratios !== undefined ? ratios.get(w.windowStart) : refMedian > 0 ? w.count / refMedian : undefined));
    const cleanedHistory: LensResult = { ...history, windows: kept };
    const full = curator.curate(obs, ref, { history });
    if (!full.referenceUsable) {
      out.unusableReference++;
      continue;
    }
    const cleaned = curator.curate(obs, ref, { history: cleanedHistory });
    const contamination = history.windows.length > 0 ? (history.windows.length - kept.length) / history.windows.length : 0;
    out.trials++;
    contaminationSum += contamination;
    out.historyWindows += history.windows.length;
    out.removedHistoryWindows += history.windows.length - kept.length;
    const bin = bins.find((b) => contamination >= b.from && contamination < b.to)!;
    bin.trials++;
    const dayKey = new Date(t.obsFrom).toISOString().slice(0, 10);
    let day = days.get(dayKey);
    if (day === undefined) days.set(dayKey, (day = { trials: 0, contamination: 0, full: emptyGateZSums(), cleaned: emptyGateZSums() }));
    day.trials++;
    day.contamination += contamination;
    const cleanedBy = new Map((cleaned.windowScores ?? []).map((s) => [s.windowStart, s]));
    const gateFull = full.selection.effectiveZThreshold;
    const gateCleaned = cleaned.selection.effectiveZThreshold;
    for (const s of full.windowScores ?? []) {
      const c = cleanedBy.get(s.windowStart);
      if (c === undefined || !Number.isFinite(s.volumeRatio)) continue;
      const band = bandOf(s.volumeRatio);
      const p = pooled.get(band)!;
      add(p.full, s.gateZ, gateFull, familyWiseAlpha(gateFull));
      add(p.cleaned, c.gateZ, gateCleaned, familyWiseAlpha(gateCleaned));
      if (band === "ordinary") {
        add(bin.full, s.gateZ, gateFull, familyWiseAlpha(gateFull));
        add(bin.cleaned, c.gateZ, gateCleaned, familyWiseAlpha(gateCleaned));
        add(day.full, s.gateZ, gateFull, familyWiseAlpha(gateFull));
        add(day.cleaned, c.gateZ, gateCleaned, familyWiseAlpha(gateCleaned));
      }
    }
    if (injection !== undefined && inj !== undefined && k % Math.max(1, Math.floor(inj.every ?? 1)) === 0) {
      const from = t.obsFrom;
      const to = t.obsFrom + inj.windows * windowMs;
      const target = obs.windows.filter((w) => w.windowStart >= from && w.windowStart < to);
      const planted = target.map((w) => shiftBinaryWindow(w, inj.shift));
      if (target.length < inj.windows || !target.every(isScorable) || planted.some((p) => p === undefined)) {
        injection.skipped++;
        continue;
      }
      const swap = new Map(target.map((w, i) => [w, planted[i]!.window]));
      const shifted = { ...obs, windows: obs.windows.map((w) => swap.get(w) ?? w) };
      const tags = inj.shift < 0 ? new Set(["dip", "step_down"]) : new Set(["spike", "step_up"]);
      const hit = (p: SnapshotPackage) => statisticalTiles(p).some((x) => tags.has(x.shapeTag) && x.regionStart < to && x.regionEnd > from);
      injection.trials++;
      if (hit(curator.curate(shifted, ref, { history }))) injection.detectedFull++;
      if (hit(curator.curate(shifted, ref, { history: cleanedHistory }))) injection.detectedCleaned++;
      if (hit(full)) injection.controlFull++;
      if (hit(cleaned)) injection.controlCleaned++;
    }
  }
  out.meanContamination = out.trials > 0 ? contaminationSum / out.trials : 0;
  out.bands = [...pooled.entries()].map(([band, p]) => ({ band, full: bandFigures(band, p.full), cleaned: bandFigures(band, p.cleaned) }));
  out.bins = bins.map((b) => ({ from: b.from, to: b.to, trials: b.trials, full: bandFigures("ordinary", b.full), cleaned: bandFigures("ordinary", b.cleaned) }));
  out.byDay = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, d]) => ({ day, trials: d.trials, meanContamination: d.contamination / d.trials, full: bandFigures("ordinary", d.full), cleaned: bandFigures("ordinary", d.cleaned) }));
  if (injection !== undefined) out.injection = injection;
  return out;
}

/**
 * The reading of step 1b fixed before any recorded day was run through it
 * (ROADMAP_BRIEF.md 2026-11-02 (2)), on the "reference" cleaning of one arm:
 *   - "supported": cleaning widens the ordinary-volume var z by ≥ 0.15, and
 *     with the history as recorded the most contaminated populated bin
 *     (share ≥ 0.1) is narrower than the least contaminated one;
 *   - "not supported": cleaning widens it by < 0.05 — the conservatism lies
 *     elsewhere;
 *   - "unclear" otherwise.
 * `overshoot` marks a cleaned null that went past N(0, 1) on the liberal side
 * (var z > 1.25 or |z|≥3 > 0.8%, stage 4's support lines): the mechanism can
 * still be right, but removing the windows is then too blunt to be a null —
 * on synthetic days a reference sitting inside a batch makes the rest of the
 * history look "low" and γ̂ comes from the batch alone.
 */
export function historyMixReading(r: Pick<HistoryMixResult, "bands" | "bins">): {
  verdict: "supported" | "not supported" | "unclear";
  widening: number;
  gradient: boolean;
  overshoot: boolean;
} {
  const o = r.bands.find((b) => b.band === "ordinary");
  if (o === undefined || o.full.windows === 0) return { verdict: "unclear", widening: 0, gradient: false, overshoot: false };
  const widening = o.cleaned.varGateZ - o.full.varGateZ;
  const populated = r.bins.filter((b) => b.full.windows >= 200);
  const least = populated[0];
  const most = populated.filter((b) => b.from >= 0.1).at(-1);
  const gradient = least !== undefined && most !== undefined && most !== least && most.full.varGateZ < least.full.varGateZ;
  const overshoot = o.cleaned.varGateZ > 1.25 || o.cleaned.over3 > 0.008;
  const verdict = widening >= 0.15 && gradient ? "supported" : widening < 0.05 ? "not supported" : "unclear";
  return { verdict, widening, gradient, overshoot };
}

// ── F2: forecast calibration (2026-10-22 (8)) ──────────────────────────────

/** Sums over (origin, horizon) pairs of one forecast method: z = (realized − forecast) / predictive SD. */
export interface ForecastCell {
  n: number;
  s: number;
  ss: number;
  o2: number;
  o3: number;
  /** Σ predictive SD and Σ squared error of the point forecast. */
  sd: number;
  se: number;
}

export const emptyForecastCell = (): ForecastCell => ({ n: 0, s: 0, ss: 0, o2: 0, o3: 0, sd: 0, se: 0 });

export function addForecastCell(a: ForecastCell, b: ForecastCell): void {
  a.n += b.n;
  a.s += b.s;
  a.ss += b.ss;
  a.o2 += b.o2;
  a.o3 += b.o3;
  a.sd += b.sd;
  a.se += b.se;
}

/** The forecasts compared: the F2 row (kriging on the fitted γ), persistence (the curator's comparison) on the fitted and on the raw γ̂, and kriging on the raw γ̂ (why the fit is there). */
export const FORECAST_METHODS = ["kriging", "persistence", "persistence-raw", "kriging-raw"] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

export interface ForecastCalibrationResult {
  origins: number;
  blindByGap: number;
  /** Cells keyed `${method}|${horizon}|${band}`, band = "ordinary" | "off" (the target window's volume against the recent windows' median). */
  cells: Map<string, ForecastCell>;
  /** Per UTC day of the origin: the F2 row at the first horizon, ordinary volume. */
  byDay: Map<string, ForecastCell>;
  /** Origins where kriging could not be solved on the fitted γ (fell back to persistence). */
  krigingFellBack: number;
}

/**
 * F2 measured (ROADMAP_BRIEF.md 2026-10-22 (7) step 2): at each origin — the
 * end of K recent windows, stepping by `strideMs` — forecast the windows
 * 1…H steps ahead with every FORECAST_METHODS entry, from the same γ̂ (history
 * ending at the origin) and the same windows, and score each realized window:
 * z = (realized mean − forecast) / √(latent forecast variance + event variance /
 * the realized count). Split by the realized window's volume like
 * runVolumeCalibration, since an ordinary-volume window is where the latent
 * model claims to hold.
 */
export function runForecastCalibration(
  stream: LoadedStream,
  opts: { lens: QObserveParams; recentWindows: number; horizons: readonly number[]; historyMs: number; strideMs: number; obsFromTs?: number; band?: readonly [number, number] },
): ForecastCalibrationResult {
  const w = opts.lens.window_ms ?? 1_000;
  const K = opts.recentWindows;
  const spanMs = K * w;
  const maxH = Math.max(...opts.horizons);
  if (maxH > K) throw new RangeError(`horizons up to ${K} windows (the trial's observation span), got ${maxH}`);
  const [lo, hi] = opts.band ?? ORDINARY_VOLUME;
  const grid = gridFor(stream, opts.lens, spanMs, opts.strideMs);
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs: opts.strideMs, obsFromTs: opts.obsFromTs });
  const out: ForecastCalibrationResult = { origins: 0, blindByGap: blind, cells: new Map(), byDay: new Map(), krigingFellBack: 0 };
  const cell = (key: string): ForecastCell => {
    let c = out.cells.get(key);
    if (c === undefined) out.cells.set(key, (c = emptyForecastCell()));
    return c;
  };
  const add = (c: ForecastCell, z: number, sd: number, err: number) => {
    c.n++;
    c.s += z;
    c.ss += z * z;
    if (Math.abs(z) >= 2) c.o2++;
    if (Math.abs(z) >= 3) c.o3++;
    c.sd += sd;
    c.se += err * err;
  };
  for (const t of trials) {
    const recentAll = grid.slice(t.refFrom, t.obsFrom).windows;
    const recent = recentAll.filter(isScorable);
    if (recent.length < 2) continue;
    const gridOrigin = t.refFrom;
    const idx = (x: { windowStart: number }) => Math.round((x.windowStart - gridOrigin) / w);
    const model = forecastModel(grid.slice(t.refFrom - opts.historyMs, t.obsFrom).windows, t.obsFrom, w, K - 1 + maxH, gridOrigin);
    const fitted = (h: number) => variogramAt(model.fitted, h);
    const raw = (h: number) => model.estimate.gamma[Math.min(model.estimate.gamma.length - 1, Math.abs(h))];
    const points = recent.map((x) => forecastPoint(x, idx(x)));
    const eventVar = pooledEventVariance(recent);
    const counts = recent.map((x) => x.count).sort((a, b) => a - b);
    const typical = counts[counts.length >> 1];
    const persistence = persistenceWeights(points);
    const observed = new Map(grid.slice(t.obsFrom, t.obsTo).windows.map((x) => [idx(x), x]));
    out.origins++;
    for (const h of opts.horizons) {
      const target = observed.get(K - 1 + h);
      if (target === undefined || !isScorable(target)) continue;
      const T = K - 1 + h;
      const ratio = typical > 0 ? target.count / typical : NaN;
      const band = ratio >= lo && ratio <= hi ? "ordinary" : "off";
      for (const method of FORECAST_METHODS) {
        const gamma = method === "kriging" || method === "persistence" ? fitted : raw;
        const kriged = method === "kriging" || method === "kriging-raw" ? krigingWeights(points, T, gamma) : undefined;
        if (method === "kriging" && kriged === undefined) out.krigingFellBack++;
        const weights = kriged?.weights ?? persistence;
        const latentVar = kriged?.latentVar ?? Math.max(0, forecastMse(points, weights, T, gamma));
        const mean = points.reduce((s, p, k) => s + weights[k] * p.mean, 0);
        const sd = Math.sqrt(latentVar + eventVar / effectiveN(target));
        const err = target.mean - mean;
        const z = sd > 0 ? err / sd : 0;
        add(cell(`${method}|${h}|${band}`), z, sd, err);
        if (method === "kriging" && h === opts.horizons[0] && band === "ordinary") {
          const day = new Date(t.obsFrom).toISOString().slice(0, 10);
          let d = out.byDay.get(day);
          if (d === undefined) out.byDay.set(day, (d = emptyForecastCell()));
          add(d, z, sd, err);
        }
      }
    }
  }
  return out;
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** The 60-minute arm's pooled alarm rate at or above this = saturated (revision 2026-10-06). */
export const H3_SATURATION_RATE = 0.95;

/**
 * The pre-registered H3 rule on the 60-minute arm, with two cases fixed before
 * any H3 data was read (revision 2026-10-06):
 *  - saturated — pooled alarm rate ≥ H3_SATURATION_RATE: the rate cannot rise
 *    where the curve is steep, so whatever r comes out is H1's dependence
 *    speaking, not the diurnal mechanism — HELD. Pooled, not "every hour":
 *    a dependent synthetic stream at 98–99% left a few hours under 95% and
 *    then read as SUPPORTED (r 0.52–0.57) on the residue;
 *  - silent — no hour alarms at all: nothing concentrates, so REJECTED
 *    (r is undefined only because the rate has no variance).
 */
export function h3Verdict(r: DiurnalResult): string {
  const scored = r.bins.filter((b) => b.trials > 0);
  if (scored.length < 3) return "NO VERDICT: fewer than 3 hours hold scored trials";
  const trials = scored.reduce((a, b) => a + b.trials, 0);
  const flagged = scored.reduce((a, b) => a + b.flagged, 0);
  if (flagged / trials >= H3_SATURATION_RATE) {
    return `HELD: ${(100 * flagged / trials).toFixed(1)}% of trials alarm (≥ ${100 * H3_SATURATION_RATE}%) — saturated by H1's dependence, the correlation cannot speak`;
  }
  if (flagged === 0) return "REJECTED (no hour alarms — nothing concentrates)";
  if (!Number.isFinite(r.correlation)) return "HELD: the correlation is undefined (no variance in rate or slope)";
  if (r.correlation >= 0.5) return `SUPPORTED (r = ${r.correlation.toFixed(2)} ≥ 0.5)`;
  if (r.correlation < 0.2) return `REJECTED (r = ${r.correlation.toFixed(2)} < 0.2)`;
  return `HELD: r = ${r.correlation.toFixed(2)} lies between 0.2 and 0.5`;
}

/**
 * Stage 3's single look (ROADMAP_BRIEF.md 2026-10-14 (12)) was taken on
 * 2026-10-22 and is spent (ROADMAP_BRIEF.md 2026-10-22): every `--holdout` is
 * refused from now on, as stage 1's and H3's are. The look read the stream only
 * up to 2026-10-21T15:43Z (the rest sat in the next day's file; see loadDayFiles);
 * the verdict stands as taken (user decision 2026-10-22). Returns the refusal.
 */
export function stage3HoldoutRefusal(fromDay: string, toDay: string, _nowMs: number): string | undefined {
  if (fromDay !== STAGE3_HOLDOUT_FROM_DAY || toDay !== STAGE3_HOLDOUT_TO_DAY) {
    return `refusing: stage 3's --holdout reads exactly ${STAGE3_HOLDOUT_FROM_DAY}…${STAGE3_HOLDOUT_TO_DAY}`;
  }
  // Spent on 2026-10-22 (ROADMAP_BRIEF.md 2026-10-22): the one look has been taken.
  return `refusing: stage 3's holdout (${STAGE3_HOLDOUT_FROM_DAY}…${STAGE3_HOLDOUT_TO_DAY}) was spent on 2026-10-22 — it had one look`;
}

/** Above this share of planned holdout trials blind by collection gaps, stage 3 gives no verdict. */
export const STAGE3_MAX_BLIND_SHARE = 0.2;

/**
 * Stage 4's single look (ROADMAP_BRIEF.md 2026-10-22 (6)) was taken on
 * 2026-11-02 and is spent (ROADMAP_BRIEF.md 2026-11-02): every `--holdout` is
 * refused from now on, as stages 1 and 3 and H3 are. The verdict (HELD, V-a too
 * conservative) stands as taken and was accepted as it is (user decision
 * 2026-11-02). Returns the refusal.
 */
export function stage4HoldoutRefusal(fromDay: string, toDay: string, _nowMs: number): string | undefined {
  if (fromDay !== STAGE4_HOLDOUT_FROM_DAY || toDay !== STAGE4_HOLDOUT_TO_DAY) {
    return `refusing: stage 4's --holdout reads exactly ${STAGE4_HOLDOUT_FROM_DAY}…${STAGE4_HOLDOUT_TO_DAY}`;
  }
  return `refusing: stage 4's holdout (${STAGE4_HOLDOUT_FROM_DAY}…${STAGE4_HOLDOUT_TO_DAY}) was spent on 2026-11-02 — it had one look`;
}

/**
 * Stage 4's rule (claim C, 2026-10-22 (6)), on the gate's z at ORDINARY volume
 * under the variogram null, pooled over the holdout week, per arm:
 *   SUPPORTED — |z| ≥ 2 share ≤ 6.0%, |z| ≥ 3 share ≤ 0.8%, and var z in [0.6, 1.25], on both arms;
 *   REJECTED  — on either arm |z| ≥ 2 > 9.1% (2× nominal), |z| ≥ 3 > 1.35% (5×), or var z > 1.5 (liberal);
 *   HELD      — otherwise, with the reason (too conservative, or between the lines).
 * NO VERDICT when an arm scored nothing or is blind by collection gaps for more
 * than STAGE3_MAX_BLIND_SHARE of its planned trials. The package alarm rate,
 * composition episodes and detection are reported beside it, not judged.
 */
export const STAGE4_RULE = {
  support: { over2: 0.06, over3: 0.008, varLo: 0.6, varHi: 1.25 },
  reject: { over2: 0.091, over3: 0.0135, varHi: 1.5 },
} as const;

/**
 * Stage 5's pre-registered rule (ROADMAP_BRIEF.md 2026-11-02 (11), claim H-clean): the
 * variogram null with history_clean "median" (cap 0.5) is calibrated at ordinary volume.
 * Judged on the cleaned gate z's variance alone, per arm; |z|≥2 / |z|≥3 are reported,
 * not judged (a rare-event rate that falls by chance ~11% of weeks on exploration).
 */
export const STAGE5_RULE = {
  support: { varLo: 0.8, varHi: 1.25 },
  reject: { varLo: 0.7, varHi: 1.4 },
} as const;

/** The sealed week ends 2026-11-15; its single look is taken on or after this day (UTC). */
export const STAGE5_FIRST_LOOK_DAY = "2026-11-16";

/**
 * The gate for stage 5's `--holdout`: exactly the sealed week, not before the week is over,
 * and never twice. Returns the refusal message, or undefined when the look may be taken.
 */
export function stage5HoldoutRefusal(fromDay: string, toDay: string, nowMs: number, holdouts: readonly Holdout[] = HOLDOUTS): string | undefined {
  const h = holdouts.find((x) => x.name === "stage 5's holdout");
  if (h === undefined) return "refusing: no stage 5 holdout is registered";
  if (h.spentOn !== undefined) return `refusing: stage 5's holdout (${h.from}…${h.to}) was spent on ${h.spentOn} — it had one look`;
  if (fromDay !== h.from || toDay !== h.to) return `refusing: stage 5's --holdout reads exactly ${h.from}…${h.to}`;
  if (nowMs < Date.parse(`${STAGE5_FIRST_LOOK_DAY}T00:00:00Z`)) {
    return `refusing: stage 5's week is still being collected; its single look is on or after ${STAGE5_FIRST_LOOK_DAY}`;
  }
  return undefined;
}

export interface Stage5Arm {
  name: string;
  /** Ordinary-volume gate z with the history as recorded, and cleaned (history_clean "median", cap 0.5). */
  full: GateZSums;
  cleaned: GateZSums;
  trials: number;
  blindByGap: number;
  /** The planted −0.1 one-window shift: caught with the history as recorded / cleaned, out of `trials`. */
  injection: { trials: number; detectedFull: number; detectedCleaned: number };
}

/** Stage 5's verdict from its two arms (V-a, 10 s): SUPPORTED / REJECTED / HELD / NO VERDICT, with the figures behind it. */
export function stage5Verdict(arms: readonly Stage5Arm[]): string {
  for (const a of arms) {
    if (a.trials === 0 || a.cleaned.n === 0) return `NO VERDICT: ${a.name} scored no trials`;
    if (a.injection.trials === 0) return `NO VERDICT: ${a.name} planted no shift, so detection cannot be compared`;
    const share = a.blindByGap / (a.trials + a.blindByGap);
    if (share > STAGE3_MAX_BLIND_SHARE) {
      return `NO VERDICT: ${a.name} is blind by collection gaps for ${(100 * share).toFixed(1)}% of its trials (> ${100 * STAGE3_MAX_BLIND_SHARE}%)`;
    }
  }
  const figs = arms.map((a) => ({ a, c: bandFigures("ordinary", a.cleaned), f: bandFigures("ordinary", a.full) }));
  const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
  const said = figs
    .map(({ a, c, f }) =>
      `${a.name}: var ${c.varGateZ.toFixed(3)} cleaned (${f.varGateZ.toFixed(3)} as recorded), |z|≥3 ${pct(c.over3)}, detection ${a.injection.detectedCleaned}/${a.injection.trials} cleaned vs ${a.injection.detectedFull} as recorded`)
    .join("; ");
  const r = STAGE5_RULE.reject;
  const out = figs.filter(({ c }) => c.varGateZ < r.varLo || c.varGateZ > r.varHi);
  if (out.length > 0) return `REJECTED (${said}; ${out.map((x) => x.a.name).join(", ")} past a reject line)`;
  const s = STAGE5_RULE.support;
  const inBand = (v: number) => v >= s.varLo && v <= s.varHi;
  const off = figs.filter(({ c, a }) => !inBand(c.varGateZ) || a.injection.detectedCleaned < a.injection.detectedFull);
  if (off.length > 0) {
    const why = off
      .map(({ c, a }) => (inBand(c.varGateZ) ? `${a.name} detects less when cleaned` : `${a.name} variance between the support and reject lines`))
      .join(", ");
    return `HELD: ${said} — ${why}`;
  }
  const note = figs.every(({ f }) => inBand(f.varGateZ))
    ? "the history as recorded was already in the band: no advantage over it is claimed, only that the cleaned null is calibrated and detects no less"
    : "the history as recorded fell outside the band, so cleaning is what brought it in";
  return `SUPPORTED (${said}; ${note})`;
}

export function stage4Verdict(arms: ReadonlyArray<{ name: string; ordinary: GateZSums; trials: number; blindByGap: number }>): string {
  for (const a of arms) {
    if (a.trials === 0 || a.ordinary.n === 0) return `NO VERDICT: ${a.name} scored no trials`;
    if (a.blindByGap / (a.trials + a.blindByGap) > STAGE3_MAX_BLIND_SHARE) {
      return `NO VERDICT: ${a.name} is blind by collection gaps for ${(100 * a.blindByGap / (a.trials + a.blindByGap)).toFixed(1)}% of its trials (> ${100 * STAGE3_MAX_BLIND_SHARE}%)`;
    }
  }
  const figs = arms.map((a) => ({ name: a.name, f: bandFigures("ordinary", a.ordinary) }));
  const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
  const said = figs.map(({ name, f }) => `${name}: |z|≥2 ${pct(f.over2)}, |z|≥3 ${pct(f.over3)}, var ${f.varGateZ.toFixed(3)}`).join("; ");
  const r = STAGE4_RULE.reject;
  const liberal = figs.filter(({ f }) => f.over2 > r.over2 || f.over3 > r.over3 || f.varGateZ > r.varHi);
  if (liberal.length > 0) return `REJECTED (${said}; ${liberal.map((x) => x.name).join(", ")} past a reject line)`;
  const s = STAGE4_RULE.support;
  const off = figs.filter(({ f }) => !(f.over2 <= s.over2 && f.over3 <= s.over3 && f.varGateZ >= s.varLo && f.varGateZ <= s.varHi));
  if (off.length === 0) return `SUPPORTED (${said})`;
  const why = off.map(({ name, f }) => `${name} ${f.varGateZ < s.varLo ? "too conservative" : "between the support and reject lines"}`).join(", ");
  return `HELD: ${said} — ${why}`;
}

/**
 * The pre-registered stage 3 rule (2026-10-14 (12)) on the variogram null's two
 * arms, V-a (H3's 60 s windows, 60 min) and V-b (H1's 1 s windows, 10 s):
 * SUPPORTED when both package alarm rates are ≤ design + 1.5pt, REJECTED when
 * either is > 2 × design, HELD in between. No verdict when either arm is blind
 * for more than STAGE3_MAX_BLIND_SHARE of its planned trials, or scored none.
 */
export function stage3Verdict(a: PositionProfile, b: PositionProfile): string {
  for (const [name, p] of [["V-a", a], ["V-b", b]] as const) {
    const planned = p.trials + p.blindByGap;
    if (p.trials === 0) return `NO VERDICT: ${name} scored no trials`;
    if (p.blindByGap / planned > STAGE3_MAX_BLIND_SHARE) {
      return `NO VERDICT: ${name} is blind by collection gaps for ${(100 * p.blindByGap / planned).toFixed(1)}% of its trials (> ${100 * STAGE3_MAX_BLIND_SHARE}%)`;
    }
  }
  const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
  const rates = `V-a ${pct(a.rate)}, V-b ${pct(b.rate)}`;
  const support = a.designTarget + 0.015;
  const reject = 2 * a.designTarget;
  if (a.rate > reject || b.rate > reject) return `REJECTED (${rates}; one is > ${pct(reject)})`;
  if (a.rate <= support && b.rate <= support) return `SUPPORTED (${rates}; both ≤ ${pct(support)})`;
  return `HELD: ${rates} — not both ≤ ${pct(support)}, neither > ${pct(reject)}`;
}

// ── φ and lag-1 autocorrelation ─────────────────────────────────────────────

export interface DispersionOptions {
  /** Window width the dispersion is measured at (pre-registered: 10 s, plus 1 s and 60 s for trend). */
  windowMs: number;
  /**
   * Length of the stretch inside which the pooled mean is estimated. Local, so
   * a slow drift (the day/night swing, H3) is not mistaken for over-dispersion
   * within windows. Default 10 min.
   */
  blockMs?: number;
  /** Measure per value of this key (e.g. "wiki") and pool, instead of the mixed stream. */
  key?: string;
  /** A block/key needs at least this many events to be measured. */
  minEvents?: number;
}

export interface DispersionResult {
  /** Blocks measured / blocks skipped because they touched a collection gap. */
  blocks: number;
  blindBlocks: number;
  /** Pooled Σχ² / Σdf over every measured (block × key); 1 under independence, > 1 = clustered. */
  phi: number;
  chiSquare: number;
  df: number;
  /** Mean lag-1 autocorrelation of window means, weighted by pair count. */
  lag1: number;
  /** ≈ −1/k under independence (the estimator's own bias); what lag1 should be compared to. */
  lag1ExpectedUnderIndependence: number;
}

/**
 * φ = window-mean variance ÷ binomial variance, as Pearson's dispersion
 * Σ nᵢ(mᵢ − p̂)² / (p̂(1 − p̂)) over (k − 1) degrees of freedom. Its expectation
 * under independent 0/1 values is 1 up to a factor N/(N − 1) (N = events in the
 * measured block, ≥ minEvents, so ≤ +0.5%) for ANY window sizes nᵢ — p̂ is the
 * count-weighted pooled mean, so the size dependence cancels — which is why the
 * synthetic check can demand φ ≈ 1 and mean it.
 */
export function dispersionProfile(
  stream: LoadedStream,
  opts: DispersionOptions,
): DispersionResult {
  const blockMs = opts.blockMs ?? 600_000;
  const minEvents = opts.minEvents ?? 200;
  const { events, gaps } = stream;
  const res: DispersionResult = {
    blocks: 0, blindBlocks: 0, phi: NaN, chiSquare: 0, df: 0, lag1: NaN, lag1ExpectedUnderIndependence: NaN,
  };
  if (events.length === 0) return res;
  const nW = Math.floor(blockMs / opts.windowMs);
  let lagNum = 0;
  let lagPairs = 0;
  let lagExpectedNum = 0;

  const first = events[0].ts;
  const last = events[events.length - 1].ts;
  for (let b0 = first; b0 + blockMs <= last; b0 += blockMs) {
    if (overlapsGap(gaps, b0, b0 + blockMs)) { res.blindBlocks++; continue; }
    const blockEvents = sliceEvents(events, b0, b0 + blockMs);
    const strata = new Map<string, LensEvent[]>();
    for (const e of blockEvents) {
      const label = opts.key === undefined ? "" : (e.keys?.[opts.key] ?? "");
      let s = strata.get(label);
      if (s === undefined) strata.set(label, (s = []));
      s.push(e);
    }
    let measured = false;
    for (const evs of strata.values()) {
      if (evs.length < minEvents) continue;
      const n = new Array<number>(nW).fill(0);
      const s = new Array<number>(nW).fill(0);
      for (const e of evs) {
        const w = Math.min(nW - 1, Math.floor((e.ts - b0) / opts.windowMs));
        n[w]++;
        s[w] += e.value;
      }
      const N = n.reduce((a, c) => a + c, 0);
      const p = s.reduce((a, c) => a + c, 0) / N;
      const k = n.filter((c) => c > 0).length;
      if (k < 4 || p <= 0 || p >= 1) continue;
      let chi = 0;
      for (let w = 0; w < nW; w++) if (n[w] > 0) chi += n[w] * (s[w] / n[w] - p) ** 2;
      res.chiSquare += chi / (p * (1 - p));
      res.df += k - 1;
      measured = true;

      // lag-1 over consecutive non-empty windows
      const m = n.map((c, w) => (c > 0 ? s[w] / c : NaN));
      const mean = m.filter((x) => !Number.isNaN(x)).reduce((a, c) => a + c, 0) / k;
      let num = 0;
      let den = 0;
      let pairs = 0;
      for (let w = 0; w < nW; w++) {
        if (Number.isNaN(m[w])) continue;
        den += (m[w] - mean) ** 2;
        if (w + 1 < nW && !Number.isNaN(m[w + 1])) {
          num += (m[w] - mean) * (m[w + 1] - mean);
          pairs++;
        }
      }
      if (den > 0 && pairs > 0) {
        lagNum += (num / den) * pairs;
        lagPairs += pairs;
        lagExpectedNum += (-1 / k) * pairs;
      }
    }
    if (measured) res.blocks++;
  }
  if (res.df > 0) res.phi = res.chiSquare / res.df;
  if (lagPairs > 0) {
    res.lag1 = lagNum / lagPairs;
    res.lag1ExpectedUnderIndependence = lagExpectedNum / lagPairs;
  }
  return res;
}

// ── Synthetic streams (for the harness's own check) ─────────────────────────

export interface SyntheticOptions {
  startTs?: number;
  durationMs: number;
  /** Poisson arrival rate, events per second. */
  rate?: number;
  /** wiki → relative volume. */
  wikis?: Readonly<Record<string, number>>;
  /** Probability of value 1. */
  p?: number;
  /**
   * Dependence knob: with this probability an event copies the previous
   * event's value instead of drawing fresh. Marginal stays p; the lag-1
   * correlation of the value sequence becomes `stickiness`, so window means
   * are over-dispersed by about (1+s)/(1−s). 0 = iid.
   */
  stickiness?: number;
  /** p(t) = p + A·sin(2π · UTC time of day): a known diurnal curve for H3's check. 0 = flat. */
  diurnalAmplitude?: number;
  seed?: number;
}

/** A recorded-stream stand-in whose ground truth (iid or sticky) is known by construction. */
export function synthesizeStream(o: SyntheticOptions): LoadedStream {
  const rng = mulberry32(o.seed ?? 1);
  const rate = o.rate ?? 32;
  const wikis = o.wikis ?? { enwiki: 5, wikidatawiki: 4, commonswiki: 3, dewiki: 2, frwiki: 1 };
  const names = Object.keys(wikis);
  const total = names.reduce((a, k) => a + wikis[k], 0);
  const p = o.p ?? 0.5;
  const s = o.stickiness ?? 0;
  const a = o.diurnalAmplitude ?? 0;
  const events: LensEvent[] = [];
  const t0 = o.startTs ?? 1_800_000_000_000;
  let t = t0;
  let prev = rng() < p ? 1 : 0;
  for (;;) {
    t += Math.max(1, Math.round((-Math.log(1 - rng()) / rate) * 1000));
    if (t >= t0 + o.durationMs) break;
    const pt = a === 0 ? p : p + a * Math.sin((2 * Math.PI * (t % DAY_MS)) / DAY_MS);
    const value = rng() < s ? prev : rng() < pt ? 1 : 0;
    prev = value;
    let r = rng() * total;
    let wiki = names[names.length - 1];
    for (const n of names) {
      if ((r -= wikis[n]) < 0) { wiki = n; break; }
    }
    events.push({ ts: t, value, keys: { wiki, type: "edit", namespace: "0" } });
  }
  return { events, gaps: [] };
}
