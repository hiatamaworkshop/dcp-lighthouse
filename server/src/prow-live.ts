/**
 * A recorded Prow stream played into the running server (ROADMAP C23).
 *
 * Until now the server's only source was MockStreamGenerator, so everything
 * learned on recorded CI results (C12–C21) stayed in CLI reports. This module
 * is the entry for a recorded stream: it holds the events of a range of
 * imported days, keeps a virtual clock that runs through them at a chosen speed,
 * and hands out the events whose time has come. index.ts feeds them to the SAME
 * RetentionBuffer → WindowHistory → Comparator chain the mock stream feeds,
 * and gives DashboardServer the virtual time as the tick's `ts`, so the live
 * view asks the question prow-replay.ts asked at that grid boundary.
 *
 * Only the clock differs from a live source. Nothing here scores, counts or
 * decides; opt-in (LIGHTHOUSE_SOURCE=prow, with LIGHTHOUSE_PROFILE=test-stream),
 * and a process that does not select it never loads this.
 */

import { loadProwRange, type ProwBuild } from "./prow-import.js";
import { buildsToEvents, prowLensEvent, type ProwEvent, type ProwEventOptions } from "./prow-events.js";
import { PersistenceDetector, type Announcement } from "./prow-persist.js";
import type { EventExtractor } from "./retention-buffer.js";
import type { TestEvent } from "./mock-stream-generator.js";

/**
 * What the retention buffer reads from a Prow event: pass 1 / fail 0, groupable by
 * job (`agentId`) and SIG (`area`). The mock extractor (testEventExtractor) files an
 * event under one of the four pilot domains, which a SIG label is not.
 */
export const prowEventExtractor: EventExtractor<TestEvent> = (raw) => prowLensEvent(raw as ProwEvent);

export interface ProwLiveOptions {
  /** Events in time order. */
  events: readonly ProwEvent[];
  /** Start of the range (first instant of the first day). The virtual clock starts here. */
  fromMs: number;
  /** End of the range (exclusive: the instant after the last day). The clock stops here. */
  toMs: number;
  /** Virtual milliseconds that pass per real millisecond. 3600 plays an hour of the recording per second. */
  speed: number;
  /** Real time at which the clock starts. Injected for tests; default Date.now() at construction. */
  startedAtMs?: number;
}

export interface ProwLiveStatus {
  source: "prow";
  /** Virtual time now. */
  virtualNow: number;
  fromMs: number;
  toMs: number;
  /** Virtual ms per real ms. */
  speed: number;
  /** Fraction of the range played, 0..1. */
  progress: number;
  /** Events handed out so far / in the range. */
  fed: number;
  total: number;
  /** The clock has reached the end and every event has been handed out. */
  finished: boolean;
}

export class ProwLiveSource {
  private readonly events: readonly ProwEvent[];
  private readonly fromMs: number;
  private readonly toMs: number;
  private readonly speed: number;
  private readonly startedAtMs: number;
  private fed = 0;
  private lastVirtual: number;

  constructor(opts: ProwLiveOptions) {
    if (!(opts.speed > 0) || !Number.isFinite(opts.speed)) throw new RangeError(`ProwLiveSource: speed must be a positive number, got ${opts.speed}`);
    if (!(opts.toMs > opts.fromMs)) throw new RangeError("ProwLiveSource: the range must end after it starts");
    for (let i = 1; i < opts.events.length; i++) {
      if (opts.events[i]!.ts < opts.events[i - 1]!.ts) throw new RangeError("ProwLiveSource: events must be in time order");
    }
    this.events = opts.events;
    this.fromMs = opts.fromMs;
    this.toMs = opts.toMs;
    this.speed = opts.speed;
    this.startedAtMs = opts.startedAtMs ?? Date.now();
    this.lastVirtual = opts.fromMs;
  }

  /** The virtual time at a real time: the range's start plus the real time elapsed times the speed, stopping at the range's end. */
  virtualNow(realNowMs: number): number {
    const t = this.fromMs + Math.max(0, realNowMs - this.startedAtMs) * this.speed;
    return Math.min(this.toMs, t);
  }

  /**
   * Hands every not-yet-given event with `ts < virtualMs` to `feed`, in order. The clock only moves
   * forward: a time before the last one given hands out nothing. Returns how many were given.
   */
  advanceTo(virtualMs: number, feed: (event: ProwEvent) => void): number {
    if (virtualMs > this.lastVirtual) this.lastVirtual = virtualMs;
    const limit = this.lastVirtual;
    let n = 0;
    while (this.fed < this.events.length && this.events[this.fed]!.ts < limit) {
      feed(this.events[this.fed]!);
      this.fed++;
      n++;
    }
    return n;
  }

  /** Where the playback is, as of the last `advanceTo`. */
  status(): ProwLiveStatus {
    const span = this.toMs - this.fromMs;
    const finished = this.lastVirtual >= this.toMs && this.fed >= this.events.length;
    return {
      source: "prow",
      virtualNow: this.lastVirtual,
      fromMs: this.fromMs,
      toMs: this.toMs,
      speed: this.speed,
      progress: Math.min(1, Math.max(0, (this.lastVirtual - this.fromMs) / span)),
      fed: this.fed,
      total: this.events.length,
      finished,
    };
  }
}

/**
 * The fastest playback the live view can follow without skipping windows (ROADMAP C26).
 *
 * DashboardServer.livePackage scores only the last `observedWindows` whole windows before the tick's
 * virtual time, and the tick runs every `tickMs` real ms. Two ticks at virtual times v1 < v2 leave no
 * window unscored iff floor(v2) − floor(v1) ≤ observedWindows · W, which holds whenever v2 − v1 ≤
 * observedWindows · W. A late timer makes v2 − v1 larger than speed · tickMs, so one window is kept as
 * headroom: the cap is (observedWindows − 1) · W / tickMs, which at the cap still covers every window
 * when a tick is up to tickMs / (observedWindows − 1) late. Above it the coarse-replay trigger and the
 * SSE would silently miss windows, so index.ts refuses such a speed at boot.
 */
export function maxReplaySpeed(windowMs: number, observedWindows: number, tickMs: number): number {
  if (!(windowMs > 0) || !(tickMs > 0) || !Number.isInteger(observedWindows) || observedWindows < 2) {
    throw new RangeError(`maxReplaySpeed: needs windowMs > 0, tickMs > 0 and an integer observedWindows ≥ 2 (got ${windowMs}, ${observedWindows}, ${tickMs})`);
  }
  return ((observedWindows - 1) * windowMs) / tickMs;
}

/** The first instant of a UTC day `YYYY-MM-DD`. */
function dayStartMs(day: string): number {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new RangeError(`not a day (YYYY-MM-DD): ${day}`);
  return t;
}

/**
 * Domain-layer per-test persistence stream (ROADMAP C22).
 *
 * Wraps PersistenceDetector (prow-persist.ts) on the virtual clock so builds are
 * fed in scheduledMs order (preserving PersistenceDetector's invariant even when
 * two builds of the same job overlap) while each Announcement surfaces only once
 * the virtual clock reaches `atMs` (the triggering build's finishedMs).
 *
 * Kept here in the test-stream domain layer — never inside SnapshotCurator or
 * lens.ts, which are domain-independent and see only test_result:v1 events
 * without build boundaries.
 */
export class ProwPersistenceFeed {
  private readonly builds: readonly ProwBuild[];
  private readonly detector: PersistenceDetector;
  private fed = 0;
  private pending: Announcement[] = [];
  private readonly surfaced: Announcement[] = [];

  constructor(builds: readonly ProwBuild[], opts: ProwEventOptions = {}) {
    this.builds = [...builds].sort((a, b) => a.scheduledMs - b.scheduledMs);
    this.detector = new PersistenceDetector(opts);
  }

  /**
   * Advances the feed to `virtualMs`: feeds builds scheduled before `virtualMs`
   * (or finishing at/before `virtualMs`) and surfaces announcements whose `atMs <= virtualMs`.
   * Returns announcements newly surfaced on this call.
   */
  advanceTo(virtualMs: number): Announcement[] {
    while (this.fed < this.builds.length && this.builds[this.fed]!.scheduledMs < virtualMs) {
      const announced = this.detector.add(this.builds[this.fed]!);
      for (const a of announced) this.pending.push(a);
      this.fed++;
    }
    if (this.pending.length === 0) return [];
    const newly: Announcement[] = [];
    const still: Announcement[] = [];
    for (const a of this.pending) {
      if (a.atMs <= virtualMs) newly.push(a);
      else still.push(a);
    }
    this.pending = still;
    newly.sort((a, b) => a.atMs - b.atMs);
    for (const a of newly) this.surfaced.push(a);
    return newly;
  }

  /** All announcements surfaced up to the last `advanceTo`, oldest first. */
  announcements(): Announcement[] {
    return [...this.surfaced];
  }
}

/**
 * The events of imported days, ready to play. Refuses what loadProwRange refuses (a day never imported
 * would read as a day without tests), and a range that holds no event.
 */
export function loadProwLive(opts: { dir: string; jobs: readonly string[]; fromDay: string; toDay: string; speed: number; startedAtMs?: number }): { source: ProwLiveSource; persistence: ProwPersistenceFeed; builds: number; missing: number } {
  const builds: ProwBuild[] = [];
  let missing = 0;
  for (const job of opts.jobs) {
    const r = loadProwRange(opts.dir, job, opts.fromDay, opts.toDay);
    builds.push(...r.builds);
    missing += r.missing.length;
  }
  const { events } = buildsToEvents(builds);
  if (events.length === 0) throw new RangeError(`no test result in ${opts.fromDay}…${opts.toDay} for ${opts.jobs.join(", ")}`);
  const fromMs = dayStartMs(opts.fromDay);
  const toMs = dayStartMs(opts.toDay) + 86_400_000;
  const source = new ProwLiveSource({ events, fromMs, toMs, speed: opts.speed, ...(opts.startedAtMs !== undefined ? { startedAtMs: opts.startedAtMs } : {}) });
  const persistence = new ProwPersistenceFeed(builds);
  return { source, persistence, builds: builds.length, missing };
}
