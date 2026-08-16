/**
 * 対策B fixture selection (ROADMAP_BRIEF.md 2026-07-28 "B. 上位モデルでの再測定").
 *
 * 対策B's question is narrower than the original §12 A/B experiment: not
 * "does curation help", but "can a stronger model reject a tile the curator
 * raised when the tile is wrong" — i.e. false-positive rejection, which only
 * a QUIET fixture (injectedAnomaly === null) can test. On an RC/AR fixture
 * the tile is the correct answer, so a "none" verdict there is a miss, not a
 * rejection; it would not distinguish "the model scrutinized the tile" from
 * "the model ignored the data".
 *
 * QUIET fixtures still occasionally show a tile — the calibrated
 * false-positive floor (~5% per window pre-対策A, ~6.5% per package after
 * the 2026-07-28 Šidák correction) is a property of the comparator, not a
 * fixture bug. This sweeps seeds until it has collected `count` of exactly
 * those cases.
 */

import { buildQuietFixture, type ABFixture } from "./ab-fixture.js";

export interface FalsePositiveSweepOptions {
  /** First seed to try. Default 1. */
  startSeed?: number;
  /** Give up after this many seeds swept, even if short of `count`. Default 5000. */
  maxSeeds?: number;
}

/**
 * Sweep QUIET-fixture seeds starting at `startSeed` and return the first
 * `count` whose curated package raised at least one tile despite nothing
 * being injected. Throws if the sweep runs out before finding enough —
 * silently returning fewer than asked for would let a caller run 対策B on
 * an accidentally-too-small set without noticing.
 */
export function findQuietFalsePositiveSeeds(
  count: number,
  opts: FalsePositiveSweepOptions = {},
): ABFixture[] {
  const startSeed = opts.startSeed ?? 1;
  const maxSeeds = opts.maxSeeds ?? 5000;
  const found: ABFixture[] = [];
  for (let seed = startSeed; seed < startSeed + maxSeeds && found.length < count; seed++) {
    const fx = buildQuietFixture(seed);
    if (fx.curated.tiles.length > 0) found.push(fx);
  }
  if (found.length < count) {
    throw new Error(
      `findQuietFalsePositiveSeeds: only found ${found.length}/${count} false-positive ` +
        `QUIET seeds within ${maxSeeds} seeds swept from ${startSeed}`,
    );
  }
  return found;
}
