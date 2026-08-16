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

export interface AnthropicAskOptions {
  /** e.g. "claude-sonnet-5" / "claude-opus-5". No default — 対策B is explicitly about comparing models, so callers must say which one. */
  model: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  maxTokens?: number;
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
      "ANTHROPIC_API_KEY is not set. 対策B trials call the Anthropic API directly " +
        "and need a real key (see ROADMAP_BRIEF.md 2026-07-28 実行基盤について).",
    );
  }
  const client = new Anthropic({ apiKey });
  const maxTokens = opts.maxTokens ?? 512;
  const model = opts.model;

  return async (prompt: string): Promise<string> => {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return textBlock?.text ?? "";
  };
}
