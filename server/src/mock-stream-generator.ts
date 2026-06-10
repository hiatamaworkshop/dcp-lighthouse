/**
 * MockStreamGenerator — synthetic test_result:v1 stream (Phase 1 Step 4).
 *
 * Emits TestEvents at a configurable rate with four agent profiles. Three
 * scenarios (AR/CG/RC) overlay perturbations on the continuous baseline.
 * Mirrors the Minecraft demo-scenario.ts ScenarioRunner pattern.
 *
 * Late-arrival: a fraction of events are delayed by 0.5–3s before emission
 * but carry their original `ts`. Downstream aggregation must be ts-driven
 * (in-order equivalence — PILOT_DATA.md §7).
 */

import { randomBits, type DomainName } from "./bitpos.js";

// ── Event schema ────────────────────────────────────────────────────────────

export type TestResult = "pass" | "fail" | "flaky";

export interface TestEvent {
  $schema: "test_result:v1";
  ts: number;
  testId: string;
  agentId: string;
  areas: number[];
  result: TestResult;
  duration: number;
  weight: number;
  commitHash: string;
}

// ── Agent profiles ──────────────────────────────────────────────────────────

export interface AgentProfile {
  passRate: number;
  flakyRate: number;
  areasPerTest: { min: number; max: number };
  domainBias?: Partial<Record<DomainName, number>>;
}

const DEFAULT_PROFILES: Record<string, AgentProfile> = {
  "agent-A": { passRate: 0.95, flakyRate: 0.01, areasPerTest: { min: 2, max: 6 } },
  "agent-B": { passRate: 0.88, flakyRate: 0.02, areasPerTest: { min: 4, max: 12 }, domainBias: { auth: 1, payment: 1, ui: 4, utils: 3 } },
  "agent-C": { passRate: 0.95, flakyRate: 0.01, areasPerTest: { min: 2, max: 6 } },
  "agent-D": { passRate: 0.90, flakyRate: 0.08, areasPerTest: { min: 2, max: 5 } },
};

const AGENT_IDS = ["agent-A", "agent-B", "agent-C", "agent-D"] as const;

// ── Generator options ───────────────────────────────────────────────────────

export interface GeneratorOptions {
  rate?: number;              // events/sec (default 50)
  lateArrivalRate?: number;   // fraction 0..1 delayed (default 0)
  seed?: number;              // for reproducible commits/ids; not a full RNG seed
  /** Multiplier for scenario sleep durations (default 1.0). Use <1 in tests to compress time. */
  timingScale?: number;
}

// ── MockStreamGenerator ─────────────────────────────────────────────────────

export type EventListener = (event: TestEvent) => void;

export class MockStreamGenerator {
  private profiles: Record<string, AgentProfile> = { ...DEFAULT_PROFILES };
  private listeners: EventListener[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate = 50;
  private lateArrivalRate = 0;
  private timingScale = 1.0;
  private activeScenario: string | null = null;
  private scenarioOverrides: Partial<Record<string, Partial<AgentProfile>>> = {};
  private cgExcludeBits: Set<number> = new Set();
  private eventCount = 0;
  private commitCounter = 0;

  /** Subscribe to emitted events. Returns unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  start(opts: GeneratorOptions = {}): void {
    if (this.timer) return;
    this.rate = opts.rate ?? 50;
    this.lateArrivalRate = opts.lateArrivalRate ?? 0;
    this.timingScale = opts.timingScale ?? 1.0;
    const intervalMs = 1000 / this.rate;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setAgentProfile(agentId: string, profile: AgentProfile): void {
    this.profiles[agentId] = profile;
  }

  getCurrentLoad(): { eventsPerSec: number; activeScenario: string | null } {
    return { eventsPerSec: this.rate, activeScenario: this.activeScenario };
  }

  /**
   * Run a named scenario. Returns when the scenario ends.
   * Scenarios overlay perturbations; baseline continues underneath.
   */
  async runScenario(id: "AR" | "CG" | "RC"): Promise<void> {
    if (this.activeScenario) return;
    this.activeScenario = id;
    try {
      switch (id) {
        case "AR": await this.runAR(); break;
        case "CG": await this.runCG(); break;
        case "RC": await this.runRC(); break;
      }
    } finally {
      this.activeScenario = null;
      this.scenarioOverrides = {};
      this.cgExcludeBits.clear();
      // Restore agent-C to baseline profile
      this.profiles["agent-C"] = { ...DEFAULT_PROFILES["agent-C"] };
    }
  }

  // ── Scenario AR: agent regression ─────────────────────────────────────────
  // agent-C pass rate drops from 95% → 70% for 30s, then recovers

  private async runAR(): Promise<void> {
    await sleep(10_000 * this.timingScale);  // 10s baseline before regression
    this.profiles["agent-C"] = { ...this.profiles["agent-C"], passRate: 0.70 };
    await sleep(30_000 * this.timingScale);  // 30s regression window
    this.profiles["agent-C"] = { ...DEFAULT_PROFILES["agent-C"] };
  }

  // ── Scenario CG: coverage gap ──────────────────────────────────────────────
  // auth bits 16–23 (absolute bits 16–23) are excluded from all area lists

  private async runCG(): Promise<void> {
    for (let b = 16; b <= 23; b++) this.cgExcludeBits.add(b);
    await sleep(30_000 * this.timingScale);
    this.cgExcludeBits.clear();
  }

  // ── Scenario RC: retroactive re-observation ────────────────────────────────
  // Under a coarse live view this looks flat. A 2s burst of failures at t=5s
  // is averaged away by the coarse window but recoverable via fine re-observation.

  private async runRC(): Promise<void> {
    await sleep(5_000 * this.timingScale);   // 5s quiet lead-in
    // 2s burst: agent-C fail rate spikes to 80%
    this.profiles["agent-C"] = { ...this.profiles["agent-C"], passRate: 0.20 };
    await sleep(2_000 * this.timingScale);
    this.profiles["agent-C"] = { ...DEFAULT_PROFILES["agent-C"] };
    await sleep(53_000 * this.timingScale);  // remainder of 60s coarse window
  }

  // ── Event generation ───────────────────────────────────────────────────────

  private tick(): void {
    const agentId = AGENT_IDS[Math.floor(Math.random() * AGENT_IDS.length)];
    const event = this.makeEvent(agentId);
    this.emit(event);
  }

  private makeEvent(agentId: string): TestEvent {
    const profile = this.profiles[agentId] ?? DEFAULT_PROFILES["agent-A"];
    const n = Math.floor(
      profile.areasPerTest.min +
      Math.random() * (profile.areasPerTest.max - profile.areasPerTest.min + 1),
    );
    let areas = randomBits(n, profile.domainBias);
    // Apply CG exclusion
    if (this.cgExcludeBits.size > 0) {
      areas = areas.filter((b) => !this.cgExcludeBits.has(b));
    }

    const r = Math.random();
    let result: TestResult;
    if (r < profile.passRate) {
      result = "pass";
    } else if (r < profile.passRate + profile.flakyRate) {
      result = "flaky";
    } else {
      result = "fail";
    }

    this.eventCount++;
    if (this.eventCount % 100 === 0) this.commitCounter++;

    return {
      $schema: "test_result:v1",
      ts: Date.now(),
      testId: `${agentId}::test_${(this.eventCount % 50).toString().padStart(3, "0")}`,
      agentId,
      areas,
      result,
      duration: Math.round(15 + Math.random() * 30),
      weight: 1.0,
      commitHash: this.commitCounter.toString(16).padStart(7, "0"),
    };
  }

  private emit(event: TestEvent): void {
    if (this.lateArrivalRate > 0 && Math.random() < this.lateArrivalRate) {
      const delay = 500 + Math.random() * 2500;
      setTimeout(() => this.broadcast(event), delay);
    } else {
      this.broadcast(event);
    }
  }

  private broadcast(event: TestEvent): void {
    for (const l of this.listeners) l(event);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
