/**
 * §12 A/B experiment harness — dry-run layers (L3-1).
 *
 * Turns an ABFixture into the two prompt arms, parses an LLM's answer, and
 * scores it against the fixture's injectedAnomaly key. Everything here is
 * pure and API-free: the only contact with a real LLM is the `askFn` seam
 * passed to runTrial, so wiring the Anthropic API (or a stub, or a human)
 * later is injection, not modification — the same substitution philosophy as
 * BrainAdapter (BRAIN_MODE=claude).
 *
 * Arm symmetry rules (the experiment's validity depends on these):
 *  - Both arms share PREAMBLE verbatim — task framing must not vary.
 *  - Both arms derive from the same (observation, reference) LensResult pair
 *    (information parity at the source — see ab-fixture.ts). The raw arm
 *    shows that pair uncurated; the curated arm shows the curator's digest
 *    of it. Whether the digest helps is exactly the question under test.
 *  - Neither prompt may leak groundTruth / injectedAnomaly.
 */

import type { ABFixture } from "./ab-fixture.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Which presentation of the same underlying LensResult pair a trial shows.
 *
 *   "raw"      — the observation/reference windows as bare number lists.
 *   "curated"  — the curator's tile digest of that same pair.
 *   "curated_context" — the same tiles, plus the multiple-comparisons context
 *                they were selected under (ROADMAP_BRIEF.md 2026-08-17).
 *
 * The third arm exists because of a measured result, not a hunch: on
 * false-positive QUIET packages, Sonnet 5 and Opus 5 confirmed every tile
 * they were shown, and their stated reasons cited σ values, neighbouring
 * windows and shape — reasoning, not transcription. A prompt that shows one
 * 2.9σ window and never says it is the most extreme of ten scanned gives no
 * basis to discount it, so "anomaly" is the correct read of what was asked.
 * This arm supplies the missing fact and asks the same question again.
 */
export type Arm = "raw" | "curated" | "curated_context";

/** The answer format the prompt asks for. */
export interface TrialAnswer {
  verdict: "anomaly" | "none";
  /** Free-form shape word (dip/spike/step_down/...) when verdict=anomaly. */
  shape?: string;
  /** Window-start timestamp the model points at when verdict=anomaly. */
  locationTs?: number;
  /**
   * One or two sentences on what in the data drove the verdict (対策E,
   * ROADMAP_BRIEF.md 2026-07-28: "reason設計"). Not scored — scoreAnswer
   * only reads verdict/locationTs — but persisted on TrialRecord so a human
   * or a second-pass judge can tell "read the tile and rubber-stamped it"
   * apart from "read the tile and evaluated it", which a bare verdict cannot
   * distinguish. Load-bearing for 対策B: a model that says "none" while a
   * tile is shown is only informative if it can say *why* the tile doesn't
   * hold up.
   */
  reason?: string;
}

export interface TrialScore {
  /** Did the verdict match whether an anomaly was actually injected? */
  verdictCorrect: boolean;
  /**
   * When an anomaly was injected AND the model said "anomaly": did it point
   * inside the injected interval (±1 window of slack — windows align to the
   * segment's first event, not to the injection boundary)? null when not
   * applicable (negative control, verdict "none", or no location given).
   */
  locationCorrect: boolean | null;
}

/** Full record of one trial — persist this; it is the experiment's raw data. */
export interface TrialRecord {
  scenario: string;
  seed: number;
  arm: Arm;
  prompt: string;
  responseText: string;
  /** null when the response could not be parsed as an answer. */
  answer: TrialAnswer | null;
  /** Unparseable answers score verdictCorrect=false — a decision that can't be read is a wrong decision. */
  score: TrialScore;
}

/** The seam: anything that maps a prompt to a completion. */
export type AskFn = (prompt: string) => Promise<string>;

// ── Prompt rendering ────────────────────────────────────────────────────────

const PREAMBLE = `You are the Brain of an observation pipeline watching a test-result stream (each event: pass=1, fail=0; window means are pass rates).
You are given a REFERENCE interval (recorded immediately before, assumed representative) and an OBSERVATION interval from the same stream.

Task: decide whether the OBSERVATION interval contains an anomaly relative to the REFERENCE.

Respond with ONLY a JSON object, no other text:
{"reason": "<one or two sentences: what in the data drove this verdict>", "verdict": "anomaly" or "none", "shape": "dip|spike|step_down|step_up|other (omit if none)", "locationTs": <window start timestamp of the anomaly (omit if none)>}`;

function renderWindows(view: { windowStarts: number[]; means: number[] }): string {
  return view.windowStarts
    .map((ts, i) => `ts=${ts} mean=${view.means[i].toFixed(3)}`)
    .join("\n");
}

/** Arm (a): the observation/reference pair as bare number lists. */
function renderRawArm(fx: ABFixture): string {
  return `REFERENCE windows (window_ms=${fx.raw.window_ms}):
${renderWindows(fx.raw.reference)}

OBSERVATION windows (window_ms=${fx.raw.window_ms}):
${renderWindows(fx.raw.observation)}`;
}

/** Arm (b): the curator's digest of the same pair. */
function renderCuratedArm(fx: ABFixture): string {
  const p = fx.curated;
  const header = `REFERENCE summary: pooled mean=${p.globalStats.mean.toFixed(3)}, stdDev=${p.globalStats.stdDev.toFixed(3)}, ${p.globalStats.windowCount} windows.${p.referenceUsable ? "" : "\nWARNING: reference unusable — no comparison was possible (blindness, not quiet)."}`;
  const span = p.spanMs ? `OBSERVATION span: ts=${p.spanMs.start}..${p.spanMs.end} (window_ms=${p.window_ms}).` : "OBSERVATION: no windows.";
  const tiles =
    p.tiles.length > 0
      ? p.tiles
          .map((t) => {
            const mag = t.magnitude !== undefined ? ` (magnitude ${t.magnitude.toFixed(1)}σ)` : "";
            return `- [${t.shapeTag}] ${t.label}${mag}\n  ${t.description}`;
          })
          .join("\n")
      : "(no tiles)";
  return `${header}
${span}

Curated snapshot tiles (mechanically selected characteristic/exceptional moments):
${tiles}`;
}

/**
 * Arm (c): the curated digest plus the family the tiles were selected from.
 *
 * States two facts and stops: how many windows were scanned, and the
 * per-comparison threshold used. It deliberately does NOT pass
 * `selection.effectiveZThreshold` — the Šidák-corrected bar. Handing over the
 * corrected number would hand over the curator's conclusion, and a model
 * agreeing with a conclusion it was given is the transcription confound the
 * 2026-07-28 re-analysis found in the original curated arm: what looked like
 * "presentation helps" was the LLM copying curator's verdict. Giving N and
 * the base threshold instead leaves the multiplicity reasoning to the model,
 * which is the thing under test.
 */
function renderCuratedContextArm(fx: ABFixture): string {
  const sel = fx.curated.selection;
  const context = `Selection context: these tiles were not handed to you in isolation — they were chosen by scanning ${sel.scoredWindowCount} window(s) of the observation interval and flagging any window whose deviation from the reference exceeded a per-comparison threshold of ${sel.baseZThreshold.toFixed(1)}σ. Judge accordingly.`;
  return `${renderCuratedArm(fx)}\n\n${context}`;
}

export function renderPrompt(fx: ABFixture, arm: Arm): string {
  const body =
    arm === "raw"
      ? renderRawArm(fx)
      : arm === "curated_context"
        ? renderCuratedContextArm(fx)
        : renderCuratedArm(fx);
  return `${PREAMBLE}\n\n${body}`;
}

// ── Answer parsing ──────────────────────────────────────────────────────────

/**
 * Tolerant extraction: accepts bare JSON, JSON inside markdown fences, or
 * JSON embedded in prose (first '{' to last '}'). Returns null when nothing
 * parseable with a valid verdict is found.
 */
export function parseAnswer(text: string): TrialAnswer | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.verdict !== "anomaly" && rec.verdict !== "none") return null;
  const answer: TrialAnswer = { verdict: rec.verdict };
  if (typeof rec.shape === "string") answer.shape = rec.shape;
  if (typeof rec.locationTs === "number" && Number.isFinite(rec.locationTs)) answer.locationTs = rec.locationTs;
  if (typeof rec.reason === "string") answer.reason = rec.reason;
  return answer;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export function scoreAnswer(fx: ABFixture, answer: TrialAnswer | null): TrialScore {
  if (answer === null) {
    return { verdictCorrect: false, locationCorrect: null };
  }
  const injected = fx.injectedAnomaly;
  const verdictCorrect = (answer.verdict === "anomaly") === (injected !== null);

  let locationCorrect: boolean | null = null;
  if (injected !== null && answer.verdict === "anomaly" && answer.locationTs !== undefined) {
    // ±1 window slack: lens windows align to the segment's first event, so
    // the injection boundary can fall up to one window inside a neighbor.
    const slack = fx.raw.window_ms;
    locationCorrect = answer.locationTs >= injected.startTs - slack && answer.locationTs < injected.endTs + slack;
  }
  return { verdictCorrect, locationCorrect };
}

// ── Trial runner ────────────────────────────────────────────────────────────

export async function runTrial(fx: ABFixture, arm: Arm, askFn: AskFn): Promise<TrialRecord> {
  const prompt = renderPrompt(fx, arm);
  const responseText = await askFn(prompt);
  const answer = parseAnswer(responseText);
  return {
    scenario: fx.scenario,
    seed: fx.seed,
    arm,
    prompt,
    responseText,
    answer,
    score: scoreAnswer(fx, answer),
  };
}
