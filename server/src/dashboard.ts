/**
 * Dashboard SSE bridge (Phase 1 Step 7).
 *
 * Exposes the observation layer output as Server-Sent Events so a browser UI
 * can display live shapes. Three channels:
 *
 *   GET /events/snapshot    — SnapshotPackage (Brain-facing curated tiles)
 *   GET /events/snapshot    — ticks per QRegistry swap history ($Q changes)
 *   GET /demo/start?scenario=AR|CG|RC  — trigger a scenario
 *   GET /demo/stop          — stop the generator
 *   GET /status             — current load
 *
 * SSE payload is always newline-delimited JSON ("data: {...}\n\n").
 * Mirrors the Minecraft dashboard SSE pattern.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MockStreamGenerator } from "./mock-stream-generator.js";
import type { TestorAdapter, STSnapshot } from "./testor-adapter.js";
import type { RuleBrain } from "./rule-brain.js";
import type { QRegistry } from "./q-registry.js";
import type { SnapshotCurator } from "./snapshot-curator.js";
import type { ObservationOverlay } from "./lens-view.js";
import type { BrainDecision } from "./brain-adapter.js";

export interface DashboardOptions {
  port?: number;
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

  constructor(
    private readonly generator: MockStreamGenerator,
    private readonly adapter: TestorAdapter,
    private readonly brain: RuleBrain,
    private readonly registry: QRegistry,
    private readonly curator: SnapshotCurator,
    private readonly overlay: ObservationOverlay,
  ) {}

  /** Start HTTP server and wire up SSE broadcast on each adapter tick. */
  start(opts: DashboardOptions = {}): void {
    const port = opts.port ?? 3001;
    const server = createServer((req, res) => this.handle(req, res));
    server.listen(port, () => {
      console.log(`[dashboard] listening on http://localhost:${port}`);
    });
  }

  /** Called by the tick loop — broadcasts snapshot + any decisions. */
  broadcast(snapshot: STSnapshot, decisions: BrainDecision[]): void {
    if (this.snapshotSubs.size === 0 && this.decisionSubs.size === 0) return;

    // Build SnapshotPackage from the overlay's coarse view (if available)
    const coarseView = this.overlay.get("coarse");
    const snapshotPkg = coarseView
      ? this.curator.curate(coarseView.current())
      : null;

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

    if (url.startsWith("/status")) {
      jsonHeaders(res);
      res.end(JSON.stringify(this.generator.getCurrentLoad()));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }
}
