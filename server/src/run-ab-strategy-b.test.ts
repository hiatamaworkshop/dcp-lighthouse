import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildFixtures } from "./run-ab-strategy-b.js";

describe("run-ab-strategy-b — argument parsing", () => {
  test("treats bare arguments as models, defaulting to the curated arm on false positives", () => {
    assert.deepEqual(parseArgs(["claude-sonnet-5", "claude-opus-5"]), {
      models: ["claude-sonnet-5", "claude-opus-5"],
      seeds: [],
      arm: "curated",
      fixtures: ["fp"],
    });
  });

  test("splits --seeds out of the model list wherever it appears", () => {
    // The re-run case: recover only the trials that failed, without paying to
    // re-sample the ones that already produced answers.
    assert.deepEqual(parseArgs(["--seeds=36,89", "claude-opus-5"]).seeds, [36, 89]);
    assert.deepEqual(parseArgs(["claude-opus-5", "--seeds=36"]).models, ["claude-opus-5"]);
  });

  test("tolerates whitespace around seed numbers", () => {
    assert.deepEqual(parseArgs(["--seeds=36, 89"]).seeds, [36, 89]);
  });

  test("rejects a non-integer seed rather than silently dropping it", () => {
    // Silently ignoring a typo'd seed would run a smaller batch than asked
    // for and report it as complete.
    assert.throws(() => parseArgs(["--seeds=36,abc"]), /not an integer/);
    assert.throws(() => parseArgs(["--seeds=3.5"]), /not an integer/);
    assert.throws(() => parseArgs(["--seeds="]), /not an integer/);
  });

  test("selects the arm and validates it against the known arms", () => {
    assert.equal(parseArgs(["--arm=curated_context", "m"]).arm, "curated_context");
    assert.equal(parseArgs(["--arm=raw", "m"]).arm, "raw");
    // A typo'd arm must not silently fall back to the default — the arm IS
    // the independent variable, so running the wrong one invalidates the run.
    assert.throws(() => parseArgs(["--arm=curated-context", "m"]), /not one of/);
    assert.throws(() => parseArgs(["--arm=", "m"]), /not one of/);
  });

  test("selects one or more fixture sets", () => {
    assert.deepEqual(parseArgs(["--fixtures=rc", "m"]).fixtures, ["rc"]);
    assert.deepEqual(parseArgs(["--fixtures=fp,rc,ar", "m"]).fixtures, ["fp", "rc", "ar"]);
    assert.throws(() => parseArgs(["--fixtures=quiet", "m"]), /not one of/);
  });
});

describe("run-ab-strategy-b — fixture sets", () => {
  test("fp yields negative controls that nonetheless carry a real tile", () => {
    for (const fx of buildFixtures("fp")) {
      assert.equal(fx.injectedAnomaly, null, "fp fixtures must have nothing injected");
      assert.ok(
        fx.curated.tiles.some((t) => t.shapeTag !== "baseline"),
        `seed ${fx.seed} must carry a false-positive anomaly tile`,
      );
    }
  });

  test("rc and ar yield true positives — the false-negative guard", () => {
    // Without this set a "better" arm could be one that simply rejects
    // everything, which would look like a clean win measured on fp alone.
    for (const set of ["rc", "ar"] as const) {
      const fixtures = buildFixtures(set);
      assert.ok(fixtures.length > 0);
      for (const fx of fixtures) {
        assert.notEqual(fx.injectedAnomaly, null, `${set} fixtures must have an injected anomaly`);
      }
    }
  });

  test("every set uses distinct seeds so records stay attributable", () => {
    for (const set of ["fp", "rc", "ar"] as const) {
      const seeds = buildFixtures(set).map((f) => f.seed);
      assert.equal(new Set(seeds).size, seeds.length, `${set} repeated a seed`);
    }
  });
});
