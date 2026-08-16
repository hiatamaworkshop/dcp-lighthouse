/**
 * 対策B runner (ROADMAP_BRIEF.md 2026-07-28 "B. 上位モデルでの再測定").
 *
 * Sends the 9 false-positive QUIET seeds (ab-strategy-b.ts) to each named
 * model, curated arm only — 対策B asks whether a stronger model can reject a
 * tile the curator raised, not the raw-vs-curated question 対策A/07-25
 * already settled. "Breaking the ceiling" means at least one trial answers
 * verdict:"none" despite the tile being shown; per the roadmap, even one
 * such trial settles the qualitative question.
 *
 * This makes real, billed Anthropic API calls. It is a standalone script,
 * not part of `npm test` — node's default test glob only picks up
 * `*.test.js`, so building this file is inert until it is run directly.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node dist/run-ab-strategy-b.js claude-sonnet-5 claude-opus-5
 *
 * Prints one JSON trial record per line to stdout (redirect to a file to
 * keep the record); progress and the ceiling-break flag go to stderr.
 */

import { findQuietFalsePositiveSeeds } from "./ab-strategy-b.js";
import { runTrial } from "./ab-harness.js";
import { makeAnthropicAsk } from "./anthropic-ask.js";

const SEED_COUNT = 9;

async function main(): Promise<void> {
  const models = process.argv.slice(2);
  if (models.length === 0) {
    console.error("usage: node dist/run-ab-strategy-b.js <model> [<model> ...]");
    process.exitCode = 1;
    return;
  }

  const fixtures = findQuietFalsePositiveSeeds(SEED_COUNT);
  console.error(`[strategy-b] seeds: ${fixtures.map((f) => f.seed).join(", ")}`);

  let brokeCeiling = false;
  for (const model of models) {
    const ask = makeAnthropicAsk({ model });
    for (const fx of fixtures) {
      const record = await runTrial(fx, "curated", ask);
      console.log(JSON.stringify({ model, ...record }));
      const rejected = record.answer?.verdict === "none";
      if (rejected) brokeCeiling = true;
      console.error(
        `[strategy-b] model=${model} seed=${fx.seed} verdict=${record.answer?.verdict ?? "(unparsed)"}` +
          (rejected ? "  <-- broke the ceiling (rejected a tile)" : ""),
      );
    }
  }

  console.error(
    brokeCeiling
      ? "[strategy-b] at least one trial rejected a tile — ceiling broken."
      : "[strategy-b] no trial rejected a tile — ceiling not broken in this run.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
