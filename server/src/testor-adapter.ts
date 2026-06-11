/**
 * TestorAdapter — normalizes TestEvent into the Phase 0 observation layer (Step 4).
 *
 * Bridges the test_result:v1 domain into the domain-independent core:
 *   - pass=1 / fail=0 / flaky=0.5 → LensEvent.value (numeric observable)
 *   - per-agent and per-domain aggregation axes via $Q[observe] group_by
 *   - feeds ObservationOverlay so SnapshotCurator can curate agent/area shapes
 *
 * Also provides EventExtractor<TestEvent> for RetentionBuffer so test events
 * can be replayed through the lens for RC scenario.
 *
 * "Pasting the skin" framing (CLAUDE.md §Phase 1): mechanism is trusted;
 * this adapter is the only Phase 1-specific layer.
 */

import type { TestEvent } from "./mock-stream-generator.js";
import type { LensEvent } from "./lens.js";
import type { EventExtractor } from "./retention-buffer.js";
import { rollUpToDomains, DOMAINS, TARGET_COVERAGE } from "./bitpos.js";

// ── Result → numeric value ──────────────────────────────────────────────────

/** Maps test result to a numeric value for LensEvent aggregation. */
export function resultToValue(result: TestEvent["result"]): number {
  switch (result) {
    case "pass":  return 1;
    case "fail":  return 0;
    case "flaky": return 0.5;
  }
}

// ── EventExtractor for RetentionBuffer ─────────────────────────────────────

/**
 * Extracts the overall pass-rate signal from any test event.
 * Used to feed the domain-independent RetentionBuffer (RC scenario replay).
 */
export const testEventExtractor: EventExtractor<TestEvent> = (raw) => ({
  ts: raw.ts,
  value: resultToValue(raw.result),
});

/**
 * Per-agent extractor factory. Returns null for events from other agents.
 * Use to build separate RetentionBuffers per agent (AR scenario).
 */
export function agentExtractor(agentId: string): EventExtractor<TestEvent> {
  return (raw) =>
    raw.agentId === agentId ? { ts: raw.ts, value: resultToValue(raw.result) } : null;
}

// ── STSnapshot — aggregated state passed to Brain ──────────────────────────

/** Per-agent aggregated stats for one observation tick. */
export interface AgentStats {
  agentId: string;
  passRate: number;
  flakyRate: number;
  eventCount: number;
}

/** Per-domain coverage stats for one observation tick. */
export interface DomainStats {
  domain: string;
  coveredBits: number;
  requiredBits: number;
  gap: number;
}

/**
 * Snapshot of the current $ST state, produced per tick and handed to Brain.
 * Contains both the domain-layer view (agent stats, coverage) and the raw
 * LensResults from the observation layer (for SnapshotCurator).
 */
export interface STSnapshot {
  ts: number;
  agents: AgentStats[];
  domains: DomainStats[];
  /** Bit positions touched in this tick window, for cumulative coverage. */
  touchedBitsThisTick: number[];
}

// ── TestorAdapter ───────────────────────────────────────────────────────────

/** Accumulates test events in a sliding window and produces STSnapshots. */
export class TestorAdapter {
  private readonly windowMs: number;
  private readonly clockFn: () => number;
  private readonly events: (TestEvent & { _received: number })[] = [];

  constructor(opts: { windowMs?: number; clockFn?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 5000;
    this.clockFn = opts.clockFn ?? Date.now;
  }

  /** Ingest one event (call from MockStreamGenerator.onEvent). */
  push(event: TestEvent): void {
    this.events.push({ ...event, _received: this.clockFn() });
    this.evict();
  }

  /** Produce a snapshot of the current window. */
  snapshot(): STSnapshot {
    this.evict();
    const now = this.clockFn();
    const window = this.events.filter((e) => e.ts >= now - this.windowMs);

    // Per-agent stats
    const agentMap = new Map<string, { pass: number; flaky: number; total: number }>();
    for (const e of window) {
      let s = agentMap.get(e.agentId);
      if (!s) { s = { pass: 0, flaky: 0, total: 0 }; agentMap.set(e.agentId, s); }
      s.total++;
      if (e.result === "pass") s.pass++;
      if (e.result === "flaky") s.flaky++;
    }
    const agents: AgentStats[] = [...agentMap.entries()].map(([agentId, s]) => ({
      agentId,
      passRate: s.total > 0 ? s.pass / s.total : 0,
      flakyRate: s.total > 0 ? s.flaky / s.total : 0,
      eventCount: s.total,
    }));

    // Per-domain coverage (bits touched in this window)
    const allBits = window.flatMap((e) => e.areas);
    const touchedBitsThisTick = [...new Set(allBits)];
    const domainCounts = rollUpToDomains(touchedBitsThisTick);

    const domains: DomainStats[] = DOMAINS.map((d) => ({
      domain: d.name,
      coveredBits: domainCounts[d.name],
      requiredBits: TARGET_COVERAGE[d.name],
      gap: Math.max(0, TARGET_COVERAGE[d.name] - domainCounts[d.name]),
    }));

    return { ts: now, agents, domains, touchedBitsThisTick };
  }

  private evict(): void {
    const cutoff = this.clockFn() - this.windowMs * 2;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
  }
}
