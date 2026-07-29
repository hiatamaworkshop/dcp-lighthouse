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
 *   GET /status             — current load
 *
 * SSE payload is always newline-delimited JSON ("data: {...}\n\n").
 * Mirrors the Minecraft dashboard SSE pattern.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MockStreamGenerator } from "./mock-stream-generator.js";
import type { TestorAdapter, STSnapshot } from "./testor-adapter.js";
import type { RuleBrain } from "./rule-brain.js";
import type { QRegistry, QObserveParams } from "./q-registry.js";
import type { SnapshotCurator } from "./snapshot-curator.js";
import type { ObservationOverlay } from "./lens-view.js";
import type { LensResult } from "./lens.js";
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
 * RetentionBuffer's retention_window_ms (120s in index.ts) or the reference
 * request falls outside what's retained and referenceUsable goes false. At
 * the default coarse window_ms=10_000, count=3 spans observation=30s +
 * reference=30s = 60s, well inside the 120s budget with margin for the
 * process not having run that long yet.
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
 * Snapping to `floor(nowTs / windowMs) * windowMs` pins the grid to absolute
 * time, so the boundaries move in whole-window steps and a past burst keeps
 * the same windowStart for as long as it stays in range. (applyLens still
 * anchors to the first event, but that is now within one inter-event gap of
 * the grid line rather than anywhere in the window. Making the grid explicit
 * belongs in QObserveParams as an `origin` stage — L4 lens-chain work.)
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
): { observation: SpanRequest; reference: SpanRequest } {
  const spanMs = windowMs * windowCount;
  const gridNow = Math.floor(nowTs / windowMs) * windowMs;
  return {
    observation: { fromTs: gridNow - spanMs, toTs: gridNow - 1 },
    reference: { fromTs: gridNow - 2 * spanMs, toTs: gridNow - spanMs - 1 },
  };
}

/**
 * The one RetentionBuffer method the dashboard needs. Narrower than the class
 * itself so the constructor doesn't have to fight RetentionBuffer<T>'s
 * generic variance (replay() doesn't depend on T; observe() does, and the
 * dashboard never calls it).
 */
export interface ReplaySource {
  replay(lens: QObserveParams, fromTs?: number, toTs?: number): LensResult;
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

  constructor(
    private readonly generator: MockStreamGenerator,
    private readonly adapter: TestorAdapter,
    private readonly brain: RuleBrain,
    private readonly registry: QRegistry,
    private readonly curator: SnapshotCurator,
    private readonly overlay: ObservationOverlay,
    private readonly buffer: ReplaySource,
  ) {}

  /** Start HTTP server and wire up SSE broadcast on each adapter tick. */
  start(opts: DashboardOptions = {}): void {
    const port = opts.port ?? 3001;
    const server = createServer((req, res) => this.handle(req, res));
    server.listen(port, () => {
      console.log(`[dashboard] listening on http://localhost:${port}`);
    });
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
    // chain (group_by, downsample, decay, agg) the moment L4 lands — lens.ts
    // states the contract: callers hand the observeParams object over
    // unchanged.
    const coarseView = this.overlay.get("coarse");
    let snapshotPkg: SnapshotPackage | null = null;
    if (coarseView) {
      const lens = this.registry.getObserve(coarseView.schemaId, coarseView.view) ?? {};
      const windowMs = lens.window_ms ?? coarseView.current().window_ms;
      const { observation, reference } = liveSpans(snapshot.ts, windowMs);
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
        `window_ms=${windowMs}, reference [${reference.fromTs}, ${reference.toTs}]. ` +
        `Empty tiles now mean blindness, not quiet; check retention_window_ms.`,
    );
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
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

    if (url.startsWith("/status")) {
      jsonHeaders(res);
      res.end(JSON.stringify(this.generator.getCurrentLoad()));
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
