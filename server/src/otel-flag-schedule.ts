/**
 * Scheduled fault-flag switching for H4 (ROADMAP_BRIEF.md 2026-09-27 (3),
 * source B: "フラグの ON/OFF をスクリプトで予定どおりに切り替え、時刻を真値ログに残す").
 *
 * Why not the Demo's own flagd-ui scheduler: it picks the flag, the variant and
 * the timing at random and keeps its history inside flagd-ui. The truth here
 * has to be fixed before the run and written by the actor that flips the flag.
 *
 * Writes go through flagd-ui's JSON API (via the Demo's Envoy, `/feature/api`),
 * the same path its UI takes, rather than to demo.flagd.json on disk:
 *   - flagd-ui reads that file once at start and later writes its cached copy
 *     back whole, so a direct file edit would be silently undone by the next
 *     UI or scheduler write;
 *   - on Docker Desktop for Windows a host-side edit of a bind-mounted file is
 *     not reliably seen by flagd's file watcher; a write from inside the VM is.
 * Each flip is then confirmed by asking flagd itself (`/flagservice`, the
 * evaluation API) which variant it serves, and the confirmed time is what the
 * truth log treats as the edge. An unconfirmed flip is logged with
 * `confirmedTs: null`, never dropped.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FlagTruthLine } from "./real-data-harness.js";

// ── Schedule ────────────────────────────────────────────────────────────────

export interface FlagScheduleOptions {
  /** OFF time before the first ON (a clean reference stretch). */
  leadMs: number;
  onMs: number;
  offMs: number;
  cycles: number;
}

export interface FlagStep {
  /** Offset from the schedule's start. */
  atMs: number;
  state: "on" | "off";
}

/** lead OFF, then `cycles` × (ON onMs, OFF offMs). Fixed before the run: nothing here is random. */
export function planFlagSchedule(o: FlagScheduleOptions): FlagStep[] {
  for (const [name, v] of Object.entries(o)) {
    if (!(Number.isFinite(v) && v >= 0)) throw new RangeError(`${name} must be a finite number ≥ 0, got ${v}`);
  }
  if (o.onMs <= 0 || !Number.isInteger(o.cycles) || o.cycles < 1) {
    throw new RangeError("onMs must be > 0 and cycles a positive integer");
  }
  const steps: FlagStep[] = [];
  for (let c = 0; c < o.cycles; c++) {
    const on = o.leadMs + c * (o.onMs + o.offMs);
    steps.push({ atMs: on, state: "on" }, { atMs: on + o.onMs, state: "off" });
  }
  return steps;
}

/** "90s" / "10m" / "1.5h" / plain milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (m === null) throw new RangeError(`not a duration: ${s}`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? "ms") as "ms" | "s" | "m" | "h"];
  return Math.round(Number(m[1]) * unit);
}

// ── flagd configuration ─────────────────────────────────────────────────────

interface FlagDef {
  defaultVariant?: string;
  variants?: Record<string, unknown>;
  targeting?: { if?: unknown[] };
  [k: string]: unknown;
}

export interface FlagdConfig {
  flags: Record<string, FlagDef>;
  [k: string]: unknown;
}

/**
 * The flag's resting variant and the value `variant` carries. Throws with the
 * names that DO exist — the Demo renamed paymentServiceFailure to paymentFailure,
 * and a label is not its value ("90%" is 0.95), so both are checked up front.
 */
export function describeFlag(
  config: FlagdConfig,
  flag: string,
  variant: string,
): { resting: string; restingValue: unknown; value: unknown } {
  const def = config.flags[flag];
  if (def === undefined) {
    throw new RangeError(`no flag "${flag}" in flagd; flags: ${Object.keys(config.flags).sort().join(", ")}`);
  }
  const variants = def.variants ?? {};
  if (!(variant in variants)) {
    throw new RangeError(`flag "${flag}" has no variant "${variant}"; variants: ${Object.keys(variants).join(", ")}`);
  }
  const resting = def.defaultVariant;
  if (resting === undefined || !(resting in variants)) throw new RangeError(`flag "${flag}" has no usable defaultVariant`);
  if (resting === variant) throw new RangeError(`"${variant}" is the flag's resting variant; pick a fault variant`);
  return { resting, restingValue: variants[resting], value: variants[variant] };
}

/**
 * A copy of `config` with `flag` switched to `variant`, the way flagd-ui's
 * Storage does it: a flag with a ternary `targeting.if` has its "then" branch
 * replaced, any other flag its defaultVariant.
 */
export function withVariant(config: FlagdConfig, flag: string, variant: string): FlagdConfig {
  const next = structuredClone(config);
  const def = next.flags[flag];
  if (def === undefined) throw new RangeError(`no flag "${flag}"`);
  const cond = def.targeting?.if;
  if (Array.isArray(cond) && cond.length === 3) cond[1] = variant;
  else def.defaultVariant = variant;
  return next;
}

// ── flagd-ui / flagd over the Demo's Envoy ──────────────────────────────────

export class FlagdClient {
  constructor(
    private readonly base = "http://localhost:8080",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** flagd-ui's current configuration (its cache — the thing its writes are built from). */
  async read(): Promise<FlagdConfig> {
    const res = await this.fetchFn(`${this.base}/feature/api/read`);
    if (!res.ok) throw new Error(`flagd-ui read: HTTP ${res.status}`);
    const body = (await res.json()) as { flags?: FlagdConfig["flags"] };
    if (body.flags === undefined) throw new Error("flagd-ui read: no flags in response");
    return { $schema: "https://flagd.dev/schema/v0/flags.json", flags: body.flags };
  }

  async write(config: FlagdConfig): Promise<void> {
    const res = await this.fetchFn(`${this.base}/feature/api/write`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ data: config }),
    });
    if (!res.ok) throw new Error(`flagd-ui write: HTTP ${res.status}`);
  }

  /**
   * The variant flagd is serving now (flagd.evaluation.v1 ResolveAll over
   * Connect/JSON). Compared by variant, not value: proto3 JSON omits a zero
   * value, so "off" = 0 would read as absent.
   */
  async servedVariant(flag: string): Promise<string | undefined> {
    const res = await this.fetchFn(`${this.base}/flagservice/flagd.evaluation.v1.Service/ResolveAll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: {} }),
    });
    if (!res.ok) throw new Error(`flagd ResolveAll: HTTP ${res.status}`);
    const body = (await res.json()) as { flags?: Record<string, { variant?: string }> };
    return body.flags?.[flag]?.variant;
  }
}

export interface FlipResult {
  /** Wall clock just before the write. */
  ts: number;
  /** When flagd was first seen serving the variant; null = not within the timeout. */
  confirmedTs: number | null;
}

/** Write the variant, then poll flagd until it serves it (or give up and say so). */
export async function flipAndConfirm(
  client: FlagdClient,
  flag: string,
  variant: string,
  o: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<FlipResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? 30_000;
  const pollMs = o.pollMs ?? 250;
  const config = await client.read();
  const ts = now();
  await client.write(withVariant(config, flag, variant));
  while (now() - ts <= timeoutMs) {
    try {
      if ((await client.servedVariant(flag)) === variant) return { ts, confirmedTs: now() };
    } catch {
      // flagd reloading or the proxy hiccuping: keep polling until the timeout
    }
    await sleep(pollMs);
  }
  return { ts, confirmedTs: null };
}

/** Append one edge to OTEL_DATA_DIR/flags.jsonl (the harness's loadFlagTruth reads it). */
export function appendTruth(dir: string, line: FlagTruthLine): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "flags.jsonl"), JSON.stringify(line) + "\n");
}
