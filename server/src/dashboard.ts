/**
 * Dashboard SSE bridge (Phase 1 Step 7).
 *
 * Exposes the observation layer output as Server-Sent Events so a browser UI
 * can display live shapes. Three channels:
 *
 *   GET /events/snapshot    — SnapshotPackage (Brain-facing curated tiles) + $Q history
 *   GET /events/decisions   — Brain decisions and replay snapshots
 *   GET /demo/start?scenario=AR|CG|RC  — trigger a scenario
 *   GET /demo/stop          — stop the generator
 *   GET /control/baseline-delta?value=N — write $Q[schema].baseline_delta
 *   GET /control/coarse-downsample?factor=N — write $Q[observe:...#coarse].downsample_factor
 *   GET /status             — current load
 *   GET /brain              — Brain diagnostics (shadow tally, LLM counters)
 *
 * SSE payload is always newline-delimited JSON ("data: {...}\n\n").
 * Mirrors the Minecraft dashboard SSE pattern.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MockStreamGenerator } from "./mock-stream-generator.js";
import type { TestorAdapter, STSnapshot } from "./testor-adapter.js";
import type { ResettableBrain } from "./brain-adapter.js";
import type { QRegistry, QObserveParams } from "./q-registry.js";
import type { SnapshotCurator } from "./snapshot-curator.js";
import type { ObservationOverlay } from "./lens-view.js";
import { floorToWindow, resolveAlign, type LensResult } from "./lens.js";
import type { BrainDecision } from "./brain-adapter.js";
import type { SnapshotPackage } from "./snapshot-curator.js";

export interface DashboardOptions {
  port?: number;
}

/**
 * How many coarse windows the live snapshot's observation (and, doubled, its
 * reference) span. Bounds the periodic broadcast to a fixed recent window
 * instead of the coarse LensView's ever-growing accumulated history — see
 * broadcast() for why unbounded growth broke the reference lens.
 *
 * Kept small deliberately: observation + reference together must fit inside
 * RetentionBuffer's retention_window_ms ($Q[pipeline], 120s at bootstrap) or
 * the reference request falls outside what's retained and referenceUsable goes
 * false. At the default coarse window_ms=10_000, count=3 spans observation=30s
 * + reference=30s = 60s, half the shipped budget — margin for the process not
 * having run that long yet. checkRetentionBudget() below says so out loud when
 * a $Q write breaks the relation.
 */
export const LIVE_REFERENCE_WINDOW_COUNT = 3;

/** A half-open [fromTs, toTs] request against the retention buffer. */
export interface SpanRequest {
  fromTs: number;
  toTs: number;
}

/**
 * The span the live snapshot observes, plus the equal-length span immediately
 * before it that serves as its reference — both snapped to a fixed window grid.
 *
 * Grid quantization is the whole point, not a rounding nicety. applyLens
 * anchors its windows to the FIRST EVENT of whatever segment it is handed
 * (lens.ts, `origin = sorted[0].ts`), so asking for [now-span, now] on every
 * tick re-anchors the grid one tick further along each time. A fixed past
 * burst then slides across the window boundaries: sometimes it lands inside a
 * single window (full magnitude), sometimes it straddles two (half magnitude
 * each). Measured on the 2026-07-29 shape (50 evt/s, 2s burst, one agent of
 * four): a completely unchanging burst produced a dip tile that toggled
 * on/off/on/off across ticks and whose magnitude swung 2.6σ–5.3σ. That is the
 * same "明滅・遅延発火" the reference lens was meant to remove, re-entering
 * through the anchor instead of through a shrinking sigma.
 *
 * Snapping to the lens's window grid pins the boundaries to absolute time, so
 * they move in whole-window steps and a past burst keeps the same windowStart
 * for as long as it stays in range.
 *
 * The grid is now declared once, in $Q — `align:"epoch"` on the coarse view
 * (index.ts) — and both readers of it go through lens.ts's floorToWindow: this
 * function, choosing what to request, and applyLens, placing events into
 * windows. Until L4 those were two independent `floor` expressions that agreed
 * by inspection; a lens whose alignment said otherwise would have silently
 * desynchronized them. `origin` is the grid's phase (0 = the plain
 * `floor(ts/window)*window` grid).
 *
 * `toTs` is inclusive-exclusive-corrected: RetentionBuffer.segment() filters
 * `ts <= toTs` while lens windows are half-open, so passing the raw boundary
 * admits one event from the next window and yields a degenerate count=1
 * trailing window. That extra window is unscorable but still counts toward
 * the Šidák family size, making the effective threshold jitter with clock
 * luck (2.42σ at n=3 vs 2.52σ at n=4).
 */
export function liveSpans(
  nowTs: number,
  windowMs: number,
  windowCount: number = LIVE_REFERENCE_WINDOW_COUNT,
  origin = 0,
): { observation: SpanRequest; reference: SpanRequest } {
  const spanMs = windowMs * windowCount;
  const gridNow = floorToWindow(nowTs, windowMs, origin);
  return {
    observation: { fromTs: gridNow - spanMs, toTs: gridNow - 1 },
    reference: { fromTs: gridNow - 2 * spanMs, toTs: gridNow - spanMs - 1 },
  };
}

/**
 * Total history the live snapshot reaches back for: observation + reference.
 * The buffer must still be holding all of it, or the reference request lands
 * outside the freshness zone and the view goes blind.
 */
export function liveLookbackMs(
  windowMs: number,
  windowCount: number = LIVE_REFERENCE_WINDOW_COUNT,
): number {
  return 2 * windowMs * windowCount;
}

/** Largest coarse window_ms whose lookback still fits in a given retention. */
export function maxCoarseWindowMs(
  retentionMs: number,
  windowCount: number = LIVE_REFERENCE_WINDOW_COUNT,
): number {
  return Math.floor(retentionMs / (2 * windowCount));
}

/**
 * The window size a $Q[observe] lens actually produces, for span-sizing
 * purposes (liveSpans / checkRetentionBudget). Folds in `downsample_factor`
 * (ROADMAP L4 residual, wired 2026-08-17): lens.ts scales its returned
 * `window_ms` by exactly this factor (`outputWindowMs = window_ms * factor`),
 * so a caller sizing spans off the raw `lens.window_ms` alone would ask
 * liveSpans for LIVE_REFERENCE_WINDOW_COUNT slots of the *pre-downsample*
 * width while applyLens merges every `factor` of those slots into one —
 * fewer, wider windows than the span was sized for. That shrinks the
 * comparator's family size silently, the same class of grid mismatch the
 * `origin`/`align` work exists to prevent, just on the downsample stage
 * instead of the window stage.
 *
 * The two inputs are scaled DIFFERENTLY and that asymmetry is the whole
 * subtlety: `lens.window_ms` is the raw declared width and must be
 * multiplied, while `fallbackWindowMs` is a `LensResult.window_ms` that
 * applyLens has ALREADY multiplied. Multiplying the fallback too would apply
 * the stage twice — a lens of `{downsample_factor: 3}` with no declared
 * window_ms produces 3000ms windows but would be sized as 9000ms. Not
 * reachable from index.ts's bootstrap (which always declares window_ms), but
 * squarely reachable by the $Q writer L3 exists to enable: a Brain writing
 * `{downsample_factor: N}` alone is a legal row, and the registry's
 * `observe:*` fallback can supply one too.
 */
export function effectiveWindowMs(lens: QObserveParams, fallbackWindowMs: number): number {
  if (lens.window_ms === undefined) return fallbackWindowMs;
  return lens.window_ms * (lens.downsample_factor ?? 1);
}

/**
 * The RetentionBuffer surface the dashboard needs. Narrower than the class
 * itself so the constructor doesn't have to fight RetentionBuffer<T>'s
 * generic variance (neither method depends on T; observe() does, and the
 * dashboard never calls it).
 *
 * getRetentionWindowMs is here so the live view can check its own lookback
 * against the budget it actually has, rather than against the 120s that used
 * to be assumed in a comment. Retention is now $Q-writable
 * (q-retention-binding.ts), so the assumption could be false at any tick.
 */
export interface ReplaySource {
  replay(lens: QObserveParams, fromTs?: number, toTs?: number): LensResult;
  getRetentionWindowMs(): number;
}

// ── SSE helpers ──────────────────────────────────────────────────────────────

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

function jsonHeaders(res: ServerResponse, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
}

function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseQuery(url: string): URLSearchParams {
  return new URL(url, "http://x").searchParams;
}

// ── DashboardServer ──────────────────────────────────────────────────────────

export class DashboardServer {
  private readonly snapshotSubs = new Set<ServerResponse>();
  private readonly decisionSubs = new Set<ServerResponse>();
  private readonly dashboardDir = resolve(import.meta.dirname, "../../dashboard");
  /** Edge-trigger state for reportReferenceBlindness(). */
  private referenceBlind = false;
  /** Edge-trigger state for checkRetentionBudget(): "<window_ms>/<retention_ms>". */
  private budgetCheckedFor = "";
  /** Edge-trigger state for checkGridAlignment(); starts true so only a lapse speaks. */
  private gridAligned = true;

  constructor(
    private readonly generator: MockStreamGenerator,
    private readonly adapter: TestorAdapter,
    // Widened from RuleBrain for ROADMAP L3: under BRAIN_MODE=claude this is a
    // ShadowBrain wrapping RuleBrain. reset() is all the dashboard ever used.
    private readonly brain: ResettableBrain,
    private readonly registry: QRegistry,
    private readonly curator: SnapshotCurator,
    private readonly overlay: ObservationOverlay,
    private readonly buffer: ReplaySource,
    /**
     * Serialisable Brain diagnostics for GET /brain (ROADMAP L3).
     *
     * A callback rather than the Brain itself, so this module keeps knowing
     * nothing about ClaudeBrain or ShadowBrain — `reset()` stays the whole of
     * the Brain surface the dashboard depends on. index.ts owns the shape
     * because index.ts is what decided which Brains exist.
     *
     * It exists at all because the shadow's evidence had no reader: index.ts
     * says promotion is "a later call made on evidence from these logs", but
     * getSummary() and getStats() had no caller outside the tests, so the only
     * observable output was console lines — and a counter nobody can read is
     * how a refusal spent a whole run being reported as unparseable.
     */
    private readonly brainDiagnostics?: () => unknown,
  ) {}

  /**
   * Start HTTP server and wire up SSE broadcast on each adapter tick.
   *
   * Returns the server so a caller can close it and — the reason it stopped
   * returning void — so a test can listen on port 0 and read back the port the
   * OS assigned. Without that, verifying the request path means binding a
   * fixed port, which collides with a dev server or with a parallel test file.
   */
  start(opts: DashboardOptions = {}): Server {
    const port = opts.port ?? 3001;
    const server = createServer((req, res) => this.handle(req, res));
    server.listen(port, () => {
      const bound = server.address();
      const actual = typeof bound === "object" && bound !== null ? bound.port : port;
      console.log(`[dashboard] listening on http://localhost:${actual}`);
    });
    return server;
  }

  /**
   * Called when Brain triggers a replayRequest and the buffer has been re-observed.
   * Pushes the fine-window SnapshotPackage to all decision subscribers so the
   * dashboard can render the "coarse hid this, fine reveals it" contrast.
   */
  broadcastReplay(pkg: SnapshotPackage): void {
    if (this.decisionSubs.size === 0) return;
    for (const res of this.decisionSubs) {
      sseWrite(res, { type: "replay_snapshot", ts: pkg.generatedAt, replayPackage: pkg });
    }
  }

  /** Called by the tick loop — broadcasts snapshot + any decisions. */
  broadcast(snapshot: STSnapshot, decisions: BrainDecision[]): void {
    if (this.snapshotSubs.size === 0 && this.decisionSubs.size === 0) return;

    // Build SnapshotPackage for the live coarse angle, freshly replayed from
    // the retention buffer over a bounded recent span rather than read off
    // the coarse LensView's own accumulated window array (if available).
    //
    // Two compounding problems with the old `curator.curate(coarseView.current())`
    // (ROADMAP_BRIEF.md 2026-07-25 "参照レンズ設計" / 2026-07-29 residual):
    //  1. Self-reference — the observation was scored against itself, so a
    //     genuine dip's own data diluted the population stdDev it was judged
    //     against, delaying/flickering its own tile as more quiet history
    //     piled in behind it (the 07-25 "粗窓dip遅延発火" finding). Already
    //     fixed for the Brain-triggered replay path below (index.ts) via an
    //     explicit reference lens; this was the periodic live broadcast's turn.
    //  2. Unbounded growth — LensView.current() re-derives over every event
    //     held since the view was created, so window count N (and thus the
    //     Šidák-corrected family size, 対策A 2026-07-28) grew for as long as
    //     the process ran. An "equal-length interval immediately before" the
    //     observed span (the RC/AR fixture idiom) doesn't fix this: as the
    //     observed span itself grows without bound, its start marches back
    //     toward — and eventually past — the start of retention, making the
    //     reference request fall outside the buffer entirely.
    //
    // Bounding both observation and reference to a fixed recent span (the
    // buffer.replay pattern index.ts already uses for interval-specified
    // replay) fixes both: N stays capped, and the reference is always the
    // span immediately preceding a span retention can actually still hold.
    // liveSpans() carries the third requirement — a fixed grid, so the two
    // spans do not re-anchor under the data every tick. See its doc comment.
    //
    // The overlay answers "is a coarse angle attached?"; $Q answers "what is
    // that angle?". Reading window_ms back off the LensResult would flatten
    // the lens to its one implemented stage and silently drop the rest of the
    // chain (group_by, decay, agg) the moment those land — lens.ts states the
    // contract: callers hand the observeParams object over unchanged.
    // downsample_factor is the one stage that already changes the effective
    // window size, so it is folded in explicitly via effectiveWindowMs()
    // rather than read back off the LensResult.
    const coarseView = this.overlay.get("coarse");
    let snapshotPkg: SnapshotPackage | null = null;
    if (coarseView) {
      const lens = this.registry.getObserve(coarseView.schemaId, coarseView.view) ?? {};
      const windowMs = effectiveWindowMs(lens, coarseView.current().window_ms);
      this.checkRetentionBudget(windowMs);
      this.checkGridAlignment(lens);
      const { observation, reference } = liveSpans(
        snapshot.ts,
        windowMs,
        LIVE_REFERENCE_WINDOW_COUNT,
        lens.origin ?? 0,
      );
      const observed = this.buffer.replay(lens, observation.fromTs, observation.toTs);
      const referenced = this.buffer.replay(lens, reference.fromTs, reference.toTs);
      snapshotPkg = this.curator.curate(observed, referenced);
      this.reportReferenceBlindness(snapshotPkg.referenceUsable, windowMs, reference);
    }

    const payload = {
      ts: snapshot.ts,
      agents: snapshot.agents,
      domains: snapshot.domains,
      snapshot: snapshotPkg,
      qHistory: this.registry.rows().slice(-20),
    };

    for (const res of this.snapshotSubs) sseWrite(res, payload);

    if (decisions.length > 0) {
      for (const res of this.decisionSubs) sseWrite(res, { ts: snapshot.ts, decisions });
    }
  }

  /**
   * Say it out loud when the live view loses its yardstick.
   *
   * An empty tile list means "quiet" only when a comparison was possible; with
   * referenceUsable=false it means "blind", and the two must never read the
   * same (the silence-vs-blindness field finding, and why SnapshotPackage
   * carries the flag at all). The Brain-triggered replay path in index.ts
   * already warns; the periodic broadcast used to fail silently.
   *
   * The realistic trigger is $Q tuning, not a bug: observation + reference
   * need 2 × windowCount × window_ms of retained history, so raising the
   * coarse window_ms past retention_window_ms / (2 × count) — 20s at the
   * shipped 120s / 3 — puts the reference outside what the buffer still
   * holds. Edge-triggered so a sustained blind period is one line, not one
   * line per tick.
   */
  private reportReferenceBlindness(usable: boolean, windowMs: number, reference: SpanRequest): void {
    if (usable) {
      this.referenceBlind = false;
      return;
    }
    if (this.referenceBlind) return;
    this.referenceBlind = true;
    console.warn(
      `[dashboard] live coarse reference UNUSABLE (no comparison possible) — ` +
        `window_ms=${windowMs}, reference [${reference.fromTs}, ${reference.toTs}], ` +
        `retention_window_ms=${this.buffer.getRetentionWindowMs()}. ` +
        `Empty tiles now mean blindness, not quiet.`,
    );
  }

  /**
   * Warn when the live view's lookback no longer fits in retention.
   *
   * The budget relation (2 × count × window_ms ≤ retention_window_ms) used to
   * live only in a comment, and both of its terms are now $Q-writable — a Brain
   * widening the coarse window or narrowing retention breaks it. Breaking it
   * does not fail loudly on its own: the reference request simply returns an
   * empty segment and the view goes blind, which without this reads as "the
   * coarse angle has nothing to report".
   *
   * Checked ahead of the replay rather than inferred from blindness afterwards,
   * because the two have different causes and want different fixes: an
   * overrunning budget is a misconfiguration (fix window_ms or retention),
   * while blindness at startup is just history not having accumulated yet and
   * resolves itself. Edge-triggered per (window_ms, retention) pair so a
   * sustained overrun is one line, and a later $Q write that changes either
   * term is reported again.
   */
  private checkRetentionBudget(windowMs: number): void {
    const retentionMs = this.buffer.getRetentionWindowMs();
    const key = `${windowMs}/${retentionMs}`;
    if (key === this.budgetCheckedFor) return;
    this.budgetCheckedFor = key;
    const lookback = liveLookbackMs(windowMs);
    if (lookback <= retentionMs) return;
    console.warn(
      `[dashboard] live coarse lookback ${lookback}ms exceeds retention ` +
        `${retentionMs}ms — the reference span is older than anything retained, ` +
        `so the live view will report no comparison. Lower coarse window_ms to ` +
        `${maxCoarseWindowMs(retentionMs)}ms or raise $Q[pipeline].retention_window_ms ` +
        `to ${lookback}ms.`,
    );
  }

  /**
   * Note when the live coarse lens leaves its grid undeclared.
   *
   * liveSpans always quantizes its requests, so a first_event-aligned lens
   * still lands close to the grid — applyLens anchors to the first event
   * inside the requested span, which on a 50 evt/s stream is within ~20ms of
   * the line. It is the *guarantee* that weakens, not (usually) the numbers:
   * on a sparse or bursty stream the first event can sit well inside the
   * window, and the two spans then sit on grids that differ by that offset —
   * the anchor-slide failure, re-entering through the lens instead of through
   * the request. Advisory rather than a fix, because a caller replaying one
   * specific segment legitimately wants first-event anchoring.
   */
  private checkGridAlignment(lens: QObserveParams): void {
    const declared = resolveAlign(lens) === "epoch";
    if (declared === this.gridAligned) return;
    this.gridAligned = declared;
    if (declared) return;
    console.warn(
      `[dashboard] live coarse lens does not declare a window grid ` +
        `(align:"first_event"). Spans are still request-quantized, but the lens ` +
        `re-anchors to the first event of each span, so window boundaries can ` +
        `drift by up to one inter-event gap. Set align:"epoch" on ` +
        `$Q[observe:...#coarse] to pin them.`,
    );
  }

  /**
   * Turn a throwing handler into a response instead of a dead process.
   *
   * Node routes an exception thrown synchronously inside a request handler to
   * `uncaughtException`, which with no listener terminates the process — so
   * before this, a single bad `/control/...` request could take the whole
   * observation layer down. A RangeError here is the lens rulebook rejecting
   * the caller's input (see validateObserveParams), which is a 400; anything
   * else is a defect on our side, which is a 500 and stays on the console.
   *
   * `headersSent` is checked because the SSE routes write their headers and
   * then keep the socket open: once the stream has begun there is no status
   * left to send, and calling writeHead again would throw from inside the
   * catch. Destroying the socket is the only honest signal left there.
   */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      this.route(req, res);
    } catch (err) {
      const validation = err instanceof RangeError;
      console[validation ? "warn" : "error"](
        `[dashboard] ${req.method ?? "GET"} ${req.url ?? "/"} failed:`,
        err,
      );
      if (res.headersSent) {
        res.destroy();
        return;
      }
      jsonHeaders(res, validation ? 400 : 500);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url.startsWith("/events/snapshot")) {
      sseHeaders(res);
      this.snapshotSubs.add(res);
      req.on("close", () => this.snapshotSubs.delete(res));
      return;
    }

    if (url.startsWith("/events/decisions")) {
      sseHeaders(res);
      this.decisionSubs.add(res);
      req.on("close", () => this.decisionSubs.delete(res));
      return;
    }

    if (url.startsWith("/demo/start")) {
      const scenario = parseQuery(url).get("scenario") as "AR" | "CG" | "RC" | null;
      if (!scenario || !["AR", "CG", "RC"].includes(scenario)) {
        jsonHeaders(res, 400);
        res.end(JSON.stringify({ error: "scenario must be AR|CG|RC" }));
        return;
      }
      // Reset brain state so each scenario run starts fresh
      this.brain.reset();
      // /demo/stop clears the generator's tick timer entirely (baseline
      // included) and nothing else restarts it — a prior stop would
      // otherwise leave every downstream collector permanently starved of
      // events. start() is a no-op if the timer is already running.
      // ROADMAP_BRIEF.md 2026-08-22.
      this.generator.start();
      this.generator.runScenario(scenario).catch(console.error);
      jsonHeaders(res);
      res.end(JSON.stringify({ started: scenario }));
      return;
    }

    if (url.startsWith("/demo/stop")) {
      this.generator.stop();
      jsonHeaders(res);
      res.end(JSON.stringify({ stopped: true }));
      return;
    }

    if (url.startsWith("/control/baseline-delta")) {
      // Brain write surface demo (ROADMAP L2-1, PILOT_DATA §11): write
      // $Q[schema:test_result:v1].baseline_delta and RuleBrain's live AR/RC
      // threshold reconfigures on the next tick without a restart.
      const raw = parseQuery(url).get("value");
      const value = raw === null ? NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        jsonHeaders(res, 400);
        res.end(JSON.stringify({ error: "value must be a non-negative number" }));
        return;
      }
      this.registry.set("schema:test_result:v1", { baseline_delta: value });
      jsonHeaders(res);
      res.end(JSON.stringify({ scope: "schema:test_result:v1", baseline_delta: value }));
      return;
    }

    if (url.startsWith("/control/coarse-downsample")) {
      // Brain/operator write surface for the downsample_factor lens stage
      // (ROADMAP L4 residual: implemented 2026-08-16, wired 2026-08-17). Merges
      // N consecutive coarse grid slots into one output window without
      // touching window_ms itself — the stage had no caller until now. Safe to
      // expose on the live path because broadcast() sizes its spans via
      // effectiveWindowMs(), which folds this factor in; see that function's
      // doc for the mismatch this would otherwise silently introduce.
      // Transport-level check only: was a number supplied at all. Whether that
      // number is an acceptable downsample_factor is the lens rulebook's call
      // (validateObserveParams, enforced by registry.set), and re-stating the
      // positive-integer rule here would put a second copy of it in a place
      // that goes stale the moment the rule moves. handle() turns the
      // resulting RangeError into a 400 carrying the rulebook's own message.
      const raw = parseQuery(url).get("factor");
      const factor = raw === null ? NaN : Number(raw);
      if (!Number.isFinite(factor)) {
        jsonHeaders(res, 400);
        res.end(JSON.stringify({ error: `factor must be a number, got ${JSON.stringify(raw)}` }));
        return;
      }
      const current = this.registry.getObserve("test_result:v1", "coarse") ?? {};
      this.registry.set("observe:test_result:v1#coarse", { ...current, downsample_factor: factor });
      jsonHeaders(res);
      res.end(JSON.stringify({ scope: "observe:test_result:v1#coarse", downsample_factor: factor }));
      return;
    }

    if (url.startsWith("/brain")) {
      // `mode: "rule"` rather than a 404: "this build has no LLM Brain" is an
      // answer, and a 404 would read to a polling client as a broken route.
      const body = JSON.stringify(this.brainDiagnostics?.() ?? { mode: "rule" });
      jsonHeaders(res);
      res.end(body);
      return;
    }

    if (url.startsWith("/status")) {
      // Body first, headers second. The reverse order commits a 200 before the
      // work that can fail has run, and handle()'s catch is then left with a
      // response it can no longer set a status on — its only remaining move is
      // to destroy the socket, which reaches the caller as a connection error
      // rather than a 500.
      const body = JSON.stringify(this.generator.getCurrentLoad());
      jsonHeaders(res);
      res.end(body);
      return;
    }

    if (url === "/" || url === "/index.html") {
      try {
        const html = readFileSync(resolve(this.dashboardDir, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("Dashboard HTML not found");
      }
      return;
    }

    if (url === "/app.js") {
      try {
        const js = readFileSync(resolve(this.dashboardDir, "app.js"), "utf-8");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(js);
      } catch {
        res.writeHead(404);
        res.end("App script not found");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }
}
