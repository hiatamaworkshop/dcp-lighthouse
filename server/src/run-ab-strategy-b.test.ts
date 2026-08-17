import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./run-ab-strategy-b.js";

describe("run-ab-strategy-b — argument parsing", () => {
  test("treats bare arguments as models and no --seeds as 'all seeds'", () => {
    assert.deepEqual(parseArgs(["claude-sonnet-5", "claude-opus-5"]), {
      models: ["claude-sonnet-5", "claude-opus-5"],
      seeds: [],
    });
  });

  test("splits --seeds out of the model list wherever it appears", () => {
    // The re-run case: recover only the trials that failed, without paying to
    // re-sample the ones that already produced answers.
    assert.deepEqual(parseArgs(["--seeds=36,89", "claude-opus-5"]), {
      models: ["claude-opus-5"],
      seeds: [36, 89],
    });
    assert.deepEqual(parseArgs(["claude-opus-5", "--seeds=36"]), {
      models: ["claude-opus-5"],
      seeds: [36],
    });
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
});
