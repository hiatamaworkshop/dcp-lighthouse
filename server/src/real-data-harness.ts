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
import { applyLens, floorToWindow, MIN_VALID_COUNT, resolveAlign, type LensEvent } from "./lens.js";
import type { QObserveParams } from "./q-registry.js";
import { SnapshotCurator, familyWiseAlpha, type SnapshotPackage, type SnapshotTile } from "./snapshot-curator.js";
import { mulberry32 } from "./calibration.js";

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
 * Read a collector directory: `YYYY-MM-DD.jsonl` (today, raw) and
 * `YYYY-MM-DD.jsonl.gz` (rolled) day files plus gaps.jsonl. `fromDay`/`toDay`
 * are inclusive UTC days; omitted = everything present.
 *
 * The day in a file name is the collector's ARRIVAL day, not the event's: a
 * straggler from just before midnight lands in the next day's file, and events
 * re-fetched after downtime land in the day they were fetched. Arrival is never
 * earlier than event time, so a `toDay` range can never contain a later day's
 * events (the holdout stays sealed); it can only miss a few seconds at its end.
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
 * Read an OTLP receiver directory (otlp-receiver.ts): value 0 = ERROR span,
 * keys = service + op, `weight` = the sampling adjusted count. Same day-file and
 * gaps.jsonl conventions as the Wikimedia collector's directory.
 */
export async function loadOtelDir(
  dir: string,
  range: { fromDay?: string; toDay?: string } = {},
): Promise<LoadedStream> {
  const pool = new KeysPool();
  return loadDayFiles(dir, range, (r) => {
    const weight = typeof r.weight === "number" && r.weight > 0 ? r.weight : 1;
    return {
      ts: r.ts as number,
      value: r.value as number,
      keys: pool.get([String(r.service), String(r.op)], ["service", "op"]),
      ...(weight !== 1 ? { weight } : {}),
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

async function loadDayFiles(
  dir: string,
  range: { fromDay?: string; toDay?: string },
  toEvent: (raw: Record<string, unknown>) => LensEvent,
): Promise<LoadedStream> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
    .filter((f) => (range.fromDay === undefined || f.slice(0, 10) >= range.fromDay) &&
      (range.toDay === undefined || f.slice(0, 10) <= range.toDay))
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
  const events: LensEvent[] = [];
  for (const f of readable) {
    const raw = createReadStream(join(dir, f));
    const input = f.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line === "") continue;
      try {
        events.push(toEvent(JSON.parse(line) as Record<string, unknown>));
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
  return { events, gaps };
}

// ── Slicing and planning ────────────────────────────────────────────────────

/** First index with ts >= t (events sorted by ts). */
function lowerBound(events: readonly LensEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Events in [from, to) — half-open, so adjacent spans never share a boundary event. */
export function sliceEvents(events: readonly LensEvent[], from: number, to: number): LensEvent[] {
  return events.slice(lowerBound(events, from), lowerBound(events, to));
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
 */
export function planTrials(
  events: readonly LensEvent[],
  gaps: readonly GapSpan[],
  o: { spanMs: number; strideMs?: number },
): { trials: TrialPlan[]; blind: number } {
  const stride = o.strideMs ?? 2 * o.spanMs;
  const trials: TrialPlan[] = [];
  let blind = 0;
  if (events.length === 0) return { trials, blind };
  const first = events[0].ts;
  const last = events[events.length - 1].ts;
  for (let t = first; t + 2 * o.spanMs <= last; t += stride) {
    const plan = { refFrom: t, obsFrom: t + o.spanMs, obsTo: t + 2 * o.spanMs };
    if (overlapsGap(gaps, plan.refFrom, plan.obsTo)) blind++;
    else trials.push(plan);
  }
  return { trials, blind };
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

function newCurator(baseZ: number): SnapshotCurator {
  return new SnapshotCurator({ spikeZThreshold: baseZ, includeBaseline: true });
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
 * Head-sample a recorded stream the way a probability sampler would: each event
 * survives with probability `p` and carries weight 1/p (times any weight it
 * already had), so a p = 1 recording can be replayed at p = 0.5 / 0.1 for H4
 * with the same events. Independent Bernoulli per event, seeded.
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
  opts: HarnessOptions & { shuffleReps?: number } = {},
): NullCalibrationResult {
  const spanMs = opts.spanMs ?? 10_000;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator = opts.curator ?? newCurator(baseZ);
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };
  const reps = opts.shuffleReps ?? 1;
  const seed = opts.seed ?? 1;
  const { trials, blind } = planTrials(stream.events, stream.gaps, { spanMs, strideMs: opts.strideMs });

  const real = tally();
  const shuffled = tally();
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
  return { planned: trials.length + blind, blindByGap: blind, real, shuffled, designTarget: familyWiseAlpha(baseZ) };
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
    trials: 0, detected: 0, power: 0, meanShiftTruth: 0,
  };
  let shiftSum = 0;
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
    const hit = statisticalTiles(pkg).some(
      (tile) => tile.regionStart < w1 && tile.regionEnd > w0 && (!grouped || tile.group === opts.target.value),
    );
    if (hit) out.detected++;
  });
  out.power = out.trials > 0 ? out.detected / out.trials : 0;
  out.meanShiftTruth = out.trials > 0 ? shiftSum / out.trials : 0;
  return out;
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
  const events: LensEvent[] = [];
  const t0 = o.startTs ?? 1_800_000_000_000;
  let t = t0;
  let prev = rng() < p ? 1 : 0;
  for (;;) {
    t += Math.max(1, Math.round((-Math.log(1 - rng()) / rate) * 1000));
    if (t >= t0 + o.durationMs) break;
    const value = rng() < s ? prev : rng() < p ? 1 : 0;
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
