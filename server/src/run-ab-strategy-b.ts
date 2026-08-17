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
 *   ANTHROPIC_API_KEY=... node dist/run-ab-strategy-b.js --seeds=36,89 claude-opus-5
 *
 * Prints one JSON trial record per line to stdout (redirect to a file to
 * keep the record); progress and the summary go to stderr.
 */

import { pathToFileURL } from "node:url";
import { findQuietFalsePositiveSeeds } from "./ab-strategy-b.js";
import { runTrial } from "./ab-harness.js";
import { makeAnthropicAsk, type AskMeta } from "./anthropic-ask.js";

const SEED_COUNT = 9;

export interface ParsedArgs {
  models: string[];
  /** Restrict the run to these seeds; empty means "all of them". */
  seeds: number[];
}

/**
 * Split `--seeds=a,b,c` out of the positional model list.
 *
 * The filter exists so a partially-failed batch can be re-run for just the
 * trials that failed, without paying for the ones that already succeeded —
 * the situation that actually arose on 2026-08-17 (2 of 18 unparseable).
 * Re-running the whole batch to recover two trials is both wasteful and
 * bad method: it would silently replace 16 already-recorded answers with
 * fresh samples.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const models: string[] = [];
  const seeds: number[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--seeds=")) {
      for (const part of arg.slice("--seeds=".length).split(",")) {
        // The empty check is not redundant with Number.isInteger: Number("")
        // is 0, so a bare `--seeds=` would otherwise parse as seed 0 and run
        // a batch nobody asked for.
        const raw = part.trim();
        const n = Number(raw);
        if (raw === "" || !Number.isInteger(n)) throw new Error(`--seeds: "${part}" is not an integer`);
        seeds.push(n);
      }
    } else {
      models.push(arg);
    }
  }
  return { models, seeds };
}

async function main(): Promise<void> {
  const { models, seeds } = parseArgs(process.argv.slice(2));
  if (models.length === 0) {
    console.error("usage: node dist/run-ab-strategy-b.js [--seeds=N,N] <model> [<model> ...]");
    process.exitCode = 1;
    return;
  }

  const all = findQuietFalsePositiveSeeds(SEED_COUNT);
  const fixtures = seeds.length > 0 ? all.filter((f) => seeds.includes(f.seed)) : all;
  if (fixtures.length === 0) {
    console.error(`[strategy-b] --seeds matched none of the ${SEED_COUNT} false-positive seeds (${all.map((f) => f.seed).join(", ")})`);
    process.exitCode = 1;
    return;
  }
  console.error(`[strategy-b] seeds: ${fixtures.map((f) => f.seed).join(", ")}`);

  let rejected = 0;
  let confirmed = 0;
  let unusable = 0;

  for (const model of models) {
    // Captured per call and attached to the record below. Sound only because
    // trials run strictly sequentially — if this loop is ever parallelized,
    // the meta must be threaded through instead of latched here.
    let lastMeta: AskMeta | null = null;
    const ask = makeAnthropicAsk({ model, onMeta: (m) => { lastMeta = m; } });

    for (const fx of fixtures) {
      lastMeta = null;
      const record = await runTrial(fx, "curated", ask);
      const meta = lastMeta as AskMeta | null;
      console.log(JSON.stringify({ model, ...record, meta }));

      const verdict = record.answer?.verdict;
      if (verdict === "none") rejected++;
      else if (verdict === "anomaly") confirmed++;
      else unusable++;

      console.error(
        `[strategy-b] model=${model} seed=${fx.seed} verdict=${verdict ?? "(unparsed)"}` +
          ` stop_reason=${meta?.stopReason ?? "?"} out_tokens=${meta?.outputTokens ?? "?"}` +
          ` text_len=${meta?.textLength ?? "?"}` +
          (verdict === "none" ? "  <-- broke the ceiling (rejected a tile)" : ""),
      );
    }
  }

  // Report the unusable count alongside the verdict counts. Saying only
  // "no trial rejected a tile" over a batch containing unreadable answers
  // would overstate the evidence — those trials measured nothing, and are
  // not the same as trials that confirmed the tile.
  console.error(
    `[strategy-b] ${rejected} rejected / ${confirmed} confirmed / ${unusable} unusable ` +
      `(${rejected + confirmed + unusable} trials). ` +
      (rejected > 0
        ? "Ceiling broken."
        : unusable > 0
          ? "Ceiling not broken among readable answers; unusable trials measured nothing."
          : "Ceiling not broken."),
  );
}

// Run only when invoked as the entry point. Without this guard, the unit test
// that imports parseArgs also *executes* the script: main() reads the test
// runner's argv, finds no model, prints usage and sets exitCode 1, failing a
// suite in which every assertion passed.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
