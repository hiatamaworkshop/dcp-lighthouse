/**
 * Direct-SDK askFn for the §12 A/B harness (対策B infra prerequisite,
 * ROADMAP_BRIEF.md 2026-07-28 "実行基盤について").
 *
 * The haiku run that produced the 66-trial dataset went through the Claude
 * Code Agent tool: ~30k tokens per trial against well under 1KB of actual
 * task, and — the finding that actually forced this module to exist —
 * Claude Code's own scaffolding can leak into what should be a clean
 * completion. ab-harness.ts's AskFn seam exists precisely so the model
 * contact point can be swapped without touching the harness; this is that
 * swap, calling the Messages API directly with nothing else in between.
 *
 * Not exercised by the test suite — it is a thin wrapper around a real
 * network call, so its only meaningful test is a real trial run (ROADMAP
 * 対策B), which costs real tokens against a real account and is not
 * something a test run should do implicitly.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AskFn } from "./ab-harness.js";

/**
 * Per-response diagnostics the AskFn contract itself cannot carry.
 *
 * Exists because of a concrete misdiagnosis (2026-08-17): two Opus trials
 * came back unparseable — one cut off mid-JSON at ~100 characters, one
 * empty — and the first explanation reached for was max_tokens exhaustion.
 * Response length ruled that out (100 chars is ~25 tokens against a 512
 * budget), but nothing in the record could say what DID stop the
 * generation, because askFn returns a bare string and the API's
 * `stop_reason` was discarded at the call site. A trial that fails for an
 * unknown reason is worse than one that fails loudly: it silently counts
 * as a wrong answer in the score.
 */
export interface AskMeta {
  /** API stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "refusal" | … */
  stopReason: string | null;
  /** Content block types actually returned; empty when the model emitted nothing. */
  contentBlockTypes: string[];
  outputTokens: number;
  /** Characters of text extracted — 0 distinguishes "empty completion" from "no text block". */
  textLength: number;
}

export interface AnthropicAskOptions {
  /** e.g. "claude-sonnet-5" / "claude-opus-5". No default — 対策B is explicitly about comparing models, so callers must say which one. */
  model: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  maxTokens?: number;
  /**
   * Invoked once per completed call with that response's diagnostics. Kept as
   * a side channel rather than widening AskFn's return type on purpose: the
   * seam's value is that ab-harness.ts stays ignorant of who answers it, and
   * a stub or a human at the other end has no stop_reason to report.
   */
  onMeta?: (meta: AskMeta) => void;
}

/**
 * Build an AskFn that calls the given model directly. Throws immediately
 * (not lazily, on first use) when no API key is available — a trial run is
 * an all-or-nothing batch; failing on trial 1 of 9 after prompts have
 * already been rendered is a worse failure mode than failing before any
 * work starts.
 */
export function makeAnthropicAsk(opts: AnthropicAskOptions): AskFn {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Both callers of this module reach the " +
        "Anthropic API directly and need a real key: 対策B trials " +
        "(ROADMAP_BRIEF.md 2026-07-28 実行基盤について) and BRAIN_MODE=claude " +
        "(ROADMAP L3, ClaudeBrain in shadow).",
    );
  }
  const client = new Anthropic({ apiKey });
  // 1024, not 512: the 対策E reason field made responses long enough that a
  // verbose model (Opus, observed 2026-08-17) can get truncated mid-JSON
  // before closing the object, which parseAnswer then correctly treats as
  // an unparseable (and therefore wrong) answer — silently losing the trial
  // rather than failing loudly.
  const maxTokens = opts.maxTokens ?? 1024;
  const model = opts.model;

  return async (prompt: string): Promise<string> => {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    // Join every text block rather than taking the first: a response split
    // across blocks would otherwise be silently truncated at the call site,
    // which is indistinguishable from the model stopping early — exactly the
    // ambiguity AskMeta exists to remove.
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    opts.onMeta?.({
      stopReason: res.stop_reason ?? null,
      contentBlockTypes: res.content.map((b) => b.type),
      outputTokens: res.usage.output_tokens,
      textLength: text.length,
    });
    return text;
  };
}
