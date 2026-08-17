import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildRcFixture, buildQuietFixture } from "./ab-fixture.js";
import { renderPrompt, parseAnswer, scoreAnswer, runTrial } from "./ab-harness.js";

describe("ab-harness — prompt rendering", () => {
  test("arms share the preamble, differ in body, and leak no ground truth", () => {
    const fx = buildRcFixture();
    const raw = renderPrompt(fx, "raw");
    const curated = renderPrompt(fx, "curated");

    // Same task framing (first line verbatim), different presentation.
    assert.equal(raw.split("\n")[0], curated.split("\n")[0]);
    assert.notEqual(raw, curated);

    assert.ok(raw.includes("REFERENCE windows"), "raw arm must show the reference numbers");
    assert.ok(raw.includes("OBSERVATION windows"), "raw arm must show the observation numbers");
    const tsLines = raw.match(/^ts=\d+ mean=\d\.\d{3}$/gm) ?? [];
    assert.ok(tsLines.length >= 18, `raw arm should list both intervals' windows, got ${tsLines.length} lines`);

    assert.ok(curated.includes("Curated snapshot tiles"), "curated arm must show tiles");
    assert.ok(curated.includes("[dip]"), "RC curated arm must contain the dip tile");
    assert.ok(!curated.match(/^ts=\d+ mean=/m), "curated arm must not dump the raw window list");

    // The answer key must never reach the model.
    for (const p of [raw, curated]) {
      assert.ok(!/burst|inject|groundTruth|answer key/i.test(p), "prompt leaks ground-truth vocabulary");
    }

    // Deterministic: same fixture renders the same prompt.
    assert.equal(raw, renderPrompt(buildRcFixture(), "raw"));
  });

  test("curated_context adds the family facts but withholds the corrected threshold", () => {
    const fx = buildRcFixture();
    const curated = renderPrompt(fx, "curated");
    const withContext = renderPrompt(fx, "curated_context");
    const sel = fx.curated.selection;

    // Strict superset: the arms must differ ONLY by the added context, or the
    // experiment measures presentation changes it did not intend.
    assert.ok(withContext.startsWith(curated), "curated_context must extend the curated arm verbatim");
    assert.ok(withContext.length > curated.length);

    // The two facts the model needs to reason about multiplicity itself.
    assert.ok(
      withContext.includes(String(sel.scoredWindowCount)),
      "must state how many windows were scanned",
    );
    assert.ok(
      withContext.includes(sel.baseZThreshold.toFixed(1)),
      "must state the per-comparison threshold",
    );

    // The conclusion must stay withheld: leaking the Šidák-corrected bar turns
    // the trial back into transcription (the 2026-07-28 confound).
    assert.ok(
      !withContext.includes(sel.effectiveZThreshold.toFixed(1)),
      "must NOT hand over the corrected threshold — that is the curator's conclusion",
    );
    assert.ok(
      !/šidák|sidak|corrected|bonferroni/i.test(withContext),
      "must not name the correction method",
    );

    // Same guarantees the other arms carry.
    assert.equal(withContext.split("\n")[0], curated.split("\n")[0], "preamble must be shared");
    assert.ok(!/burst|inject|groundTruth|answer key/i.test(withContext), "prompt leaks ground-truth vocabulary");
  });
});

describe("ab-harness — answer parsing", () => {
  test("accepts bare, fenced, and prose-embedded JSON; rejects garbage", () => {
    assert.deepEqual(parseAnswer('{"verdict": "none"}'), { verdict: "none" });
    assert.deepEqual(
      parseAnswer('```json\n{"verdict": "anomaly", "shape": "dip", "locationTs": 2008000}\n```'),
      { verdict: "anomaly", shape: "dip", locationTs: 2008000 },
    );
    assert.deepEqual(
      parseAnswer('Looking at the data, {"verdict": "anomaly", "shape": "dip"} is my conclusion.'),
      { verdict: "anomaly", shape: "dip" },
    );
    assert.equal(parseAnswer("the stream looks fine to me"), null);
    assert.equal(parseAnswer('{"shape": "dip"}'), null, "missing verdict must not parse");
    assert.equal(parseAnswer('{"verdict": "maybe"}'), null, "invalid verdict must not parse");
  });

  test("carries an optional reason field (対策E) without requiring it", () => {
    assert.deepEqual(
      parseAnswer('{"reason": "the dip tile sits at 4.2sigma, well past the reference spread", "verdict": "anomaly", "shape": "dip"}'),
      { verdict: "anomaly", shape: "dip", reason: "the dip tile sits at 4.2sigma, well past the reference spread" },
    );
    // Absent reason must not fabricate one, and must not block parsing.
    assert.deepEqual(parseAnswer('{"verdict": "none"}'), { verdict: "none" });
    // A non-string reason is dropped rather than rejecting the whole answer —
    // reason is explanatory, not scored, so a malformed one shouldn't cost
    // the trial its verdict.
    assert.deepEqual(parseAnswer('{"verdict": "none", "reason": 42}'), { verdict: "none" });
  });
});

describe("ab-harness — scoring", () => {
  test("scores verdict and location against the injected anomaly", () => {
    const rc = buildRcFixture();
    const dip = rc.curated.tiles.find((t) => t.shapeTag === "dip")!;

    // A model that reads the dip tile correctly.
    const good = scoreAnswer(rc, { verdict: "anomaly", shape: "dip", locationTs: dip.regionStart });
    assert.equal(good.verdictCorrect, true);
    assert.equal(good.locationCorrect, true);

    // Right verdict, wrong place (points into the pre-burst baseline).
    const wrongPlace = scoreAnswer(rc, { verdict: "anomaly", locationTs: 2_000_000 });
    assert.equal(wrongPlace.verdictCorrect, true);
    assert.equal(wrongPlace.locationCorrect, false);

    // Missed the anomaly entirely.
    const miss = scoreAnswer(rc, { verdict: "none" });
    assert.equal(miss.verdictCorrect, false);
    assert.equal(miss.locationCorrect, null);

    // Unparseable response is a wrong decision, not a skipped trial.
    assert.equal(scoreAnswer(rc, null).verdictCorrect, false);

    // Negative control: "none" is right, "anomaly" is the false positive.
    const quiet = buildQuietFixture();
    assert.equal(scoreAnswer(quiet, { verdict: "none" }).verdictCorrect, true);
    assert.equal(scoreAnswer(quiet, { verdict: "anomaly", locationTs: 2_005_000 }).verdictCorrect, false);
    assert.equal(scoreAnswer(quiet, { verdict: "anomaly", locationTs: 2_005_000 }).locationCorrect, null);
  });
});

describe("ab-harness — trial runner (askFn seam)", () => {
  test("runs a full trial against a stub without any API", async () => {
    const fx = buildRcFixture();
    let seenPrompt = "";
    const stub = async (prompt: string): Promise<string> => {
      seenPrompt = prompt;
      const dip = fx.curated.tiles.find((t) => t.shapeTag === "dip")!;
      return `{"verdict": "anomaly", "shape": "dip", "locationTs": ${dip.regionStart}}`;
    };

    const record = await runTrial(fx, "curated", stub);
    assert.equal(seenPrompt, renderPrompt(fx, "curated"), "askFn must receive the rendered prompt");
    assert.equal(record.scenario, "RC");
    assert.equal(record.seed, fx.seed);
    assert.equal(record.arm, "curated");
    assert.equal(record.score.verdictCorrect, true);
    assert.equal(record.score.locationCorrect, true);
    assert.ok(record.prompt.length > 0 && record.responseText.length > 0, "record must persist prompt and response");
  });
});
