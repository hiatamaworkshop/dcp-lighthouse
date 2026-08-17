/**
 * 対策B runner (ROADMAP_BRIEF.md 2026-07-28 "B. 上位モデルでの再測定").
 *
 * Sends fixtures to each named model and records the verdicts. 対策B asks
 * whether a stronger model can reject a tile the curator raised — not the
 * raw-vs-curated question 対策A/07-25 already settled — so the default
 * fixture set is the false-positive QUIET seeds (ab-strategy-b.ts) and the
 * default arm is `curated`.
 *
 * Two axes are selectable because the interesting runs vary them:
 *
 *   --arm=       which presentation (see ab-harness.ts's Arm). The 2026-08-17
 *                finding motivates `curated_context`, which adds the
 *                multiple-comparisons facts the plain curated arm omits.
 *   --fixtures=  which ground truth. `fp` (false positives) measures whether
 *                the model REJECTS a wrong tile; `rc`/`ar` measure whether it
 *                still CONFIRMS right ones.
 *
 * Running only `fp` cannot establish that an arm is better. An arm that made
 * the model reject everything would look like a clean win on `fp` alone while
 * being strictly worse — so a claim about `curated_context` needs the `rc`/`ar`
 * companion run as its false-negative guard. Hence the summary below reports
 * ANSWER CORRECTNESS against each fixture's own ground truth rather than raw
 * "none" counts, which mean opposite things on the two sets.
 *
 * This makes real, billed Anthropic API calls. It is a standalone script, not
 * part of `npm test` — node's default test glob only picks up `*.test.js`, so
 * building this file is inert until it is run directly.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node dist/run-ab-strategy-b.js claude-sonnet-5 claude-opus-5
 *   ANTHROPIC_API_KEY=... node dist/run-ab-strategy-b.js --seeds=36,89 claude-opus-5
 *   ANTHROPIC_API_KEY=... node dist/run-ab-strategy-b.js --arm=curated_context --fixtures=fp,rc,ar claude-opus-5
 *
 * Prints one JSON trial record per line to stdout (redirect to a file to keep
 * the record); progress and the summary go to stderr.
 */

import { pathToFileURL } from "node:url";
import { findQuietFalsePositiveSeeds } from "./ab-strategy-b.js";
import { buildRcFixture, buildArFixture, type ABFixture } from "./ab-fixture.js";
import { runTrial, type Arm } from "./ab-harness.js";
import { makeAnthropicAsk, type AskMeta } from "./anthropic-ask.js";

const SEED_COUNT = 9;

const ARMS: readonly Arm[] = ["raw", "curated", "curated_context"];

/** Which ground truth a run is measured against. */
export type FixtureSet = "fp" | "rc" | "ar";

const FIXTURE_SETS: readonly FixtureSet[] = ["fp", "rc", "ar"];

export interface ParsedArgs {
  models: string[];
  /** Restrict the run to these seeds; empty means "all of them". */
  seeds: number[];
  arm: Arm;
  fixtures: FixtureSet[];
}

/**
 * Split flags out of the positional model list.
 *
 * `--seeds` exists so a partially-failed batch can be re-run for just the
 * trials that failed, without paying for the ones that already succeeded —
 * the situation that arose on 2026-08-17 (2 of 18 unparseable). Re-running
 * the whole batch to recover two trials is both wasteful and bad method: it
 * would silently replace already-recorded answers with fresh samples.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const models: string[] = [];
  const seeds: number[] = [];
  let arm: Arm = "curated";
  let fixtures: FixtureSet[] = ["fp"];

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
    } else if (arg.startsWith("--arm=")) {
      const v = arg.slice("--arm=".length).trim();
      if (!ARMS.includes(v as Arm)) throw new Error(`--arm: "${v}" is not one of ${ARMS.join("|")}`);
      arm = v as Arm;
    } else if (arg.startsWith("--fixtures=")) {
      const parts = arg
        .slice("--fixtures=".length)
        .split(",")
        .map((s) => s.trim());
      for (const p of parts) {
        if (!FIXTURE_SETS.includes(p as FixtureSet)) {
          throw new Error(`--fixtures: "${p}" is not one of ${FIXTURE_SETS.join("|")}`);
        }
      }
      fixtures = parts as FixtureSet[];
    } else {
      models.push(arg);
    }
  }
  return { models, seeds, arm, fixtures };
}

/**
 * Build the fixtures for a set.
 *
 * `fp` sweeps for QUIET packages that raised a real (non-baseline) tile
 * despite nothing being injected — the only set on which a "none" verdict is
 * a rejection rather than a miss. `rc`/`ar` are plain seeded true-positive
 * fixtures, so seeds 1..SEED_COUNT are as good as any.
 */
export function buildFixtures(set: FixtureSet): ABFixture[] {
  if (set === "fp") return findQuietFalsePositiveSeeds(SEED_COUNT);
  const build = set === "rc" ? buildRcFixture : buildArFixture;
  return Array.from({ length: SEED_COUNT }, (_, i) => build(i + 1));
}

interface Tally {
  correct: number;
  incorrect: number;
  unusable: number;
}

async function main(): Promise<void> {
  const { models, seeds, arm, fixtures: sets } = parseArgs(process.argv.slice(2));
  if (models.length === 0) {
    console.error(
      "usage: node dist/run-ab-strategy-b.js [--arm=raw|curated|curated_context] " +
        "[--fixtures=fp,rc,ar] [--seeds=N,N] <model> [<model> ...]",
    );
    process.exitCode = 1;
    return;
  }

  const tallies = new Map<string, Tally>();

  for (const set of sets) {
    const all = buildFixtures(set);
    const fixtures = seeds.length > 0 ? all.filter((f) => seeds.includes(f.seed)) : all;
    if (fixtures.length === 0) {
      console.error(
        `[strategy-b] --seeds matched none of set "${set}" (${all.map((f) => f.seed).join(", ")})`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(`[strategy-b] set=${set} arm=${arm} seeds: ${fixtures.map((f) => f.seed).join(", ")}`);

    for (const model of models) {
      // Captured per call and attached to the record below. Sound only because
      // trials run strictly sequentially — if this loop is ever parallelized,
      // the meta must be threaded through instead of latched here.
      let lastMeta: AskMeta | null = null;
      const ask = makeAnthropicAsk({ model, onMeta: (m) => { lastMeta = m; } });
      const key = `${model} ${set}`;
      const tally = tallies.get(key) ?? { correct: 0, incorrect: 0, unusable: 0 };
      tallies.set(key, tally);

      for (const fx of fixtures) {
        lastMeta = null;
        const record = await runTrial(fx, arm, ask);
        const meta = lastMeta as AskMeta | null;
        console.log(JSON.stringify({ model, set, ...record, meta }));

        const verdict = record.answer?.verdict;
        if (verdict === undefined) tally.unusable++;
        else if (record.score.verdictCorrect) tally.correct++;
        else tally.incorrect++;

        console.error(
          `[strategy-b] ${model} set=${set} seed=${fx.seed} verdict=${verdict ?? "(unparsed)"}` +
            ` correct=${verdict === undefined ? "?" : record.score.verdictCorrect}` +
            ` stop_reason=${meta?.stopReason ?? "?"} out_tokens=${meta?.outputTokens ?? "?"}` +
            ` text_len=${meta?.textLength ?? "?"}`,
        );
      }
    }
  }

  // Report correctness per (model, set) and keep `unusable` visible. Folding
  // unusable trials into either column would overstate the evidence — they
  // measured nothing, and are not the same as a wrong answer.
  console.error("[strategy-b] ── summary (arm=" + arm + ") ──");
  for (const [key, t] of tallies) {
    const graded = t.correct + t.incorrect;
    const pct = graded > 0 ? ((100 * t.correct) / graded).toFixed(0) + "%" : "n/a";
    console.error(
      `[strategy-b] ${key}: ${t.correct}/${graded} correct (${pct})` +
        (t.unusable > 0 ? `, ${t.unusable} unusable` : ""),
    );
  }
  console.error(
    "[strategy-b] note: on set=fp a correct answer is a REJECTION of the tile; " +
      "on rc/ar it is a CONFIRMATION. An arm is only better if it improves fp " +
      "without degrading rc/ar.",
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
