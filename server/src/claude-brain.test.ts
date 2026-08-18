/**
 * ClaudeBrain tests (ROADMAP L3).
 *
 * Every test injects an askFn, so the suite never makes a network call —
 * the same discipline ab-harness.test.ts uses. What is being checked is the
 * three things that are ours rather than the model's: what we ask, what we
 * accept back, and what we do while waiting.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBrain, parseBrainAnswer, renderBrainPrompt } from "./claude-brain.js";
import type { STSnapshot } from "./testor-adapter.js";

const SCOPE = "observe:test_result:v1#fine";

function snap(ts: number, cRate = 0.95): STSnapshot {
  return {
    ts,
    agents: [
      { agentId: "agent-A", passRate: 0.95, flakyRate: 0.01, eventCount: 20 },
      { agentId: "agent-C", passRate: cRate, flakyRate: 0.01, eventCount: 20 },
    ],
    domains: [
      { domain: "auth", coveredBits: 24, requiredBits: 32, gap: 8 },
      { domain: "ui", coveredBits: 60, requiredBits: 64, gap: 4 },
    ],
    touchedBitsThisTick: [1, 2, 3],
  };
}

/** Resolve pending microtasks so a detached deliberation can settle. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── Prompt ──────────────────────────────────────────────────────────────────

describe("renderBrainPrompt", () => {
  test("splits history into a reference period and an observation period", () => {
    const history = [snap(1000), snap(2000), snap(3000), snap(4000), snap(5000, 0.70)];
    const prompt = renderBrainPrompt(history, 2);

    assert.match(prompt, /REFERENCE \(3 tick\(s\)/);
    assert.match(prompt, /OBSERVATION \(most recent 2 tick\(s\)/);
    // The observation block lists ticks individually; the reference is pooled.
    assert.match(prompt, /ts=4000 agent-A=0\.950 agent-C=0\.950/);
    assert.match(prompt, /ts=5000 agent-A=0\.950 agent-C=0\.700/);
    assert.ok(!prompt.includes("ts=1000 agent-A"), "reference ticks should be pooled, not listed");
  });

  test("teaches the lens vocabulary, since proposing a lens is the point of L3", () => {
    const prompt = renderBrainPrompt([snap(1000)], 1);
    for (const field of ["window_ms", "group_by", "downsample_factor", "decay", "decay_anchor", "origin", "align"]) {
      assert.ok(prompt.includes(field), `prompt should name the lens field ${field}`);
    }
  });

  test("carries current coverage gaps", () => {
    const prompt = renderBrainPrompt([snap(1000)], 1);
    assert.match(prompt, /auth covered 24\/32, gap 8/);
  });

  test("says so rather than rendering an empty contrast when there is no history", () => {
    assert.match(renderBrainPrompt([], 5), /no observations yet/);
  });

  test("does not claim a reference period it does not have", () => {
    const prompt = renderBrainPrompt([snap(1000), snap(2000)], 5);
    assert.match(prompt, /REFERENCE \(0 tick\(s\)/);
    assert.match(prompt, /the observation period is all the history there is/);
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

describe("parseBrainAnswer — form is tolerated", () => {
  test("accepts JSON wrapped in prose or fences", () => {
    const body = `{"decisions":[{"type":"quarantine","reason":"agent-D is flaky","agentId":"agent-D"}]}`;
    for (const text of [body, "```json\n" + body + "\n```", `Here you go:\n${body}\nHope that helps.`]) {
      const out = parseBrainAnswer(text, SCOPE);
      assert.equal(out.unparseable, false);
      assert.equal(out.decisions.length, 1, `failed on: ${text}`);
      assert.equal(out.decisions[0].type, "quarantine");
    }
  });

  test("reports unparseable rather than inventing an empty decision list", () => {
    for (const text of ["", "no json here", "{ not json", `{"decisions": "not an array"}`]) {
      const out = parseBrainAnswer(text, SCOPE);
      assert.equal(out.unparseable, true, `should be unparseable: ${text}`);
      assert.equal(out.decisions.length, 0);
    }
  });

  test("an empty decision list is silence, not an unparseable answer", () => {
    const out = parseBrainAnswer(`{"decisions":[]}`, SCOPE);
    assert.equal(out.unparseable, false);
    assert.equal(out.decisions.length, 0);
    assert.equal(out.rejected, 0);
  });
});

describe("parseBrainAnswer — content is not", () => {
  test("drops a type the pipeline does not have", () => {
    const out = parseBrainAnswer(
      `{"decisions":[{"type":"launchMissiles","reason":"why not","agentId":"agent-C"}]}`,
      SCOPE,
    );
    assert.equal(out.decisions.length, 0);
    assert.equal(out.rejected, 1);
    assert.equal(out.unparseable, false, "a well-formed answer with a bad entry is not unparseable");
  });

  test("drops a decision that names no subject to act on", () => {
    const out = parseBrainAnswer(
      `{"decisions":[
         {"type":"rerouteSchema","reason":"someone regressed"},
         {"type":"schemaUpdate","reason":"coverage is thin"}
       ]}`,
      SCOPE,
    );
    assert.equal(out.decisions.length, 0);
    assert.equal(out.rejected, 2);
  });

  test("drops a decision with no reason", () => {
    const out = parseBrainAnswer(
      `{"decisions":[{"type":"quarantine","agentId":"agent-D","reason":"   "}]}`,
      SCOPE,
    );
    assert.equal(out.decisions.length, 0);
    assert.equal(out.rejected, 1);
  });

  test("REJECTS a replayRequest whose lens the rulebook refuses", () => {
    // Each of these throws in validateObserveParams. They must not reach the
    // decision log: index.ts's registry.set catch is the backstop, not the gate.
    const bad = [
      `{"window_ms": -5}`,
      `{"window_ms": 1000, "downsample_factor": 0}`,
      `{"align": "sideways"}`,
      `{"decay": "exp(tau=0s)"}`,
      `{"decay": "wobble(3)"}`,
      `{"group_by": "agentId"}`,
      `{"agg_func": "median"}`,
    ];
    for (const lens of bad) {
      const out = parseBrainAnswer(
        `{"decisions":[{"type":"replayRequest","reason":"look closer","lens":${lens}}]}`,
        SCOPE,
      );
      assert.equal(out.decisions.length, 0, `should have rejected lens ${lens}`);
      assert.equal(out.rejected, 1);
    }
  });

  test("a rejected proposal does not cost the other decisions in the same answer", () => {
    const out = parseBrainAnswer(
      `{"decisions":[
         {"type":"replayRequest","reason":"bad lens","lens":{"window_ms":0}},
         {"type":"rerouteSchema","reason":"agent-C dropped to 0.70","agentId":"agent-C"}
       ]}`,
      SCOPE,
    );
    assert.equal(out.rejected, 1);
    assert.equal(out.decisions.length, 1);
    assert.equal(out.decisions[0].type, "rerouteSchema");
  });

  test("a valid replayRequest becomes a $Q proposal with the interval attached", () => {
    const out = parseBrainAnswer(
      `{"decisions":[{"type":"replayRequest","reason":"recover the burst",
        "lens":{"window_ms":1000,"group_by":["agentId"]},"fromTs":5000,"toTs":9000}]}`,
      SCOPE,
    );
    assert.equal(out.rejected, 0);
    const d = out.decisions[0];
    assert.equal(d.qProposal?.scope, SCOPE);
    assert.deepEqual(d.qProposal?.params, {
      window_ms: 1000,
      group_by: ["agentId"],
      fromTs: 5000,
      toTs: 9000,
    });
  });

  test("keeps the whole lens chain, not just window_ms", () => {
    // The proposal is handed to buffer.replay unchanged (index.ts destructures
    // only fromTs/toTs off it), so dropping a stage here would silently replay
    // through a different lens than the one that was proposed.
    const out = parseBrainAnswer(
      `{"decisions":[{"type":"replayRequest","reason":"decayed grouped view",
        "lens":{"window_ms":500,"group_by":["agentId"],"downsample_factor":2,
                "align":"epoch","origin":0,"decay":"exp(tau=30s)","decay_anchor":"segment_end"}}]}`,
      SCOPE,
    );
    assert.deepEqual(out.decisions[0].qProposal?.params, {
      window_ms: 500,
      group_by: ["agentId"],
      downsample_factor: 2,
      align: "epoch",
      origin: 0,
      decay: "exp(tau=30s)",
      decay_anchor: "segment_end",
    });
  });
});

// ── Cadence and detachment ──────────────────────────────────────────────────

describe("ClaudeBrain — deliberation is detached from the tick", () => {
  test("decisions surface on a LATER decide(), naming the snapshot that provoked them", async () => {
    let resolveAsk: (s: string) => void = () => {};
    const brain = new ClaudeBrain({
      askFn: () => new Promise<string>((r) => { resolveAsk = r; }),
      minIntervalMs: 0,
    });

    brain.observe(snap(1000, 0.70));
    // The model has not answered yet: this tick has nothing to say.
    assert.deepEqual(brain.decide(), []);

    resolveAsk(`{"decisions":[{"type":"rerouteSchema","reason":"agent-C at 0.70","agentId":"agent-C"}]}`);
    await settle();

    const decisions = brain.decide();
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0].meta as { snapshotTs?: number }).snapshotTs, 1000,
      "the decision should name the snapshot it reasoned about, not the tick that drained it");
    assert.equal((decisions[0].meta as { brain?: string }).brain, "claude");
    assert.deepEqual(brain.decide(), [], "draining should clear the queue");
  });

  test("does not stack a second call behind one still in flight", async () => {
    let calls = 0;
    const brain = new ClaudeBrain({
      askFn: () => { calls++; return new Promise<string>(() => {}); }, // never resolves
      minIntervalMs: 0,
    });

    for (let ts = 1000; ts <= 10_000; ts += 1000) brain.observe(snap(ts));
    await settle();

    assert.equal(calls, 1, "an in-flight deliberation must latch out further calls");
    assert.equal(brain.getStats().inFlight, true);
  });

  test("honours the minimum interval between deliberations", async () => {
    let calls = 0;
    let vt = 0;
    const brain = new ClaudeBrain({
      askFn: async () => { calls++; return `{"decisions":[]}`; },
      minIntervalMs: 15_000,
      clockFn: () => vt,
    });

    // 30 ticks of virtual second, i.e. 30s — two deliberations' worth.
    for (let i = 0; i < 30; i++) {
      vt = i * 1000;
      brain.observe(snap(vt));
      await settle();
    }
    assert.equal(calls, 2, `expected 2 calls in 30 virtual seconds at a 15s floor, got ${calls}`);
  });

  test("a failing model is counted and reported, never thrown into the tick loop", async () => {
    const errors: Error[] = [];
    const brain = new ClaudeBrain({
      askFn: async () => { throw new Error("503 overloaded"); },
      minIntervalMs: 0,
      onError: (e) => errors.push(e),
    });

    assert.doesNotThrow(() => brain.observe(snap(1000)));
    await settle();

    assert.equal(brain.getStats().failures, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /503 overloaded/);
    assert.deepEqual(brain.decide(), []);
    // The failure is on the record, not just in a counter.
    const last = brain.getDeliberations().at(-1)!;
    assert.match(last.error!, /503 overloaded/);
  });

  test("an unparseable answer is recorded WITH its raw text", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => "I'm afraid I can't do that.",
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();

    assert.equal(brain.getStats().unparseable, 1);
    assert.equal(brain.getDeliberations().at(-1)!.rawAnswer, "I'm afraid I can't do that.",
      "an unparseable answer must be inspectable, not merely counted");
  });

  test("noAction is recorded but not emitted as an action", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => `{"decisions":[{"type":"noAction","reason":"everything is at baseline"}]}`,
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();

    assert.deepEqual(brain.decide(), [], "noAction should not reach the action channel");
    const rec = brain.getDeliberations().at(-1)!;
    assert.equal(rec.decisions.length, 1, "but it must stay distinguishable from never having been asked");
    assert.equal(rec.decisions[0].type, "noAction");
    assert.equal(brain.getStats().deliberations, 1);
  });

  test("counts rejected proposals so a model that keeps proposing bad lenses is visible", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => `{"decisions":[{"type":"replayRequest","reason":"nope","lens":{"window_ms":-1}}]}`,
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();

    assert.equal(brain.getStats().rejectedProposals, 1);
    assert.deepEqual(brain.decide(), []);
  });

  test("history is bounded, and the prompt reflects the most recent ticks", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => `{"decisions":[]}`,
      minIntervalMs: Number.POSITIVE_INFINITY, // never deliberate; just accumulate
      historySize: 5,
    });
    for (let ts = 1000; ts <= 20_000; ts += 1000) brain.observe(snap(ts));

    const prompt = brain.currentPrompt();
    assert.match(prompt, /Current tick ts=20000/);
    assert.ok(!prompt.includes("ts=1000 "), "history should have been trimmed to the newest 5 ticks");
  });

  test("reset clears history and queued decisions", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => `{"decisions":[{"type":"quarantine","reason":"flaky","agentId":"agent-D"}]}`,
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();
    assert.equal(brain.getDeliberations().length, 1);

    brain.reset();
    assert.deepEqual(brain.decide(), []);
    assert.equal(brain.getDeliberations().length, 0);
    assert.match(brain.currentPrompt(), /no observations yet/);
  });

  test("an answer still in the post at reset() never reaches the next scenario", async () => {
    // /demo/start resets mid-deliberation as a matter of course: a call runs
    // 5-10s against a 15s floor. Before the generation guard, the previous
    // scenario's decision was drained by the next one — and index.ts applies a
    // replayRequest by type, so as primary this would have written $Q.
    let resolveAsk!: (answer: string) => void;
    const brain = new ClaudeBrain({
      askFn: () => new Promise<string>((r) => { resolveAsk = r; }),
      minIntervalMs: 0,
    });

    brain.observe(snap(1000, 0.70));
    brain.reset();                                    // scenario boundary
    resolveAsk(`{"decisions":[{"type":"quarantine","reason":"previous scenario","agentId":"agent-C"}]}`);
    await settle();

    assert.deepEqual(brain.decide(), [], "a superseded answer must not be delivered");
    assert.equal(brain.getDeliberations().length, 0, "nor recorded against the new scenario");
    // Counted, not silently dropped: the call was issued and billed.
    assert.equal(brain.getStats().discarded, 1);
    assert.equal(brain.getStats().deliberations, 0);
  });

  test("reset() does not open the in-flight latch", async () => {
    // The latch is one of the two spend guards. reset() used to clear it, so a
    // second call started beside the first and the older one's finally then
    // cleared the flag out from under the newer.
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const brain = new ClaudeBrain({
      askFn: async () => { calls++; await gate; return `{"decisions":[]}`; },
      minIntervalMs: 15_000,
    });

    brain.observe(snap(1000));
    brain.reset();
    brain.observe(snap(2000));
    await settle();
    assert.equal(calls, 1, "resetting must not let a second call start beside the first");

    // ...and the latch is released when the outstanding call returns, so the
    // new scenario is not locked out forever.
    release();
    await settle();
    assert.equal(brain.getStats().inFlight, false);
    brain.observe(snap(3000));
    await settle();
    assert.equal(calls, 2, "the interval floor is rewound by reset, so the next tick deliberates");
  });

  test("a refusal is named as one, not filed under 'could not write JSON'", async () => {
    // Opus 5 refuses this Brain's prompt outright (11/11, 2026-08-18): zero
    // content blocks, so the answer is "". Without the stop_reason it lands in
    // `unparseable` and reads as a model that cannot produce the format.
    // Reported from INSIDE the askFn, which is where makeAnthropicAsk reports
    // it: onMeta fires before the promise resolves, so the meta always lands
    // before the awaiting deliberation resumes.
    let brain!: ClaudeBrain;
    brain = new ClaudeBrain({
      askFn: async () => {
        brain.noteAnswerMeta({ stopReason: "refusal", contentBlockTypes: [], outputTokens: 0, textLength: 0 });
        return "";
      },
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();

    const stats = brain.getStats();
    assert.equal(stats.refusals, 1);
    assert.equal(stats.lastStopReason, "refusal");
    assert.equal(stats.unparseable, 1, "it did also fail to parse — both facts are true");
    assert.equal(brain.getDeliberations().at(-1)!.answerMeta?.stopReason, "refusal",
      "the record must carry why the answer was empty, not just that it was");
  });

  test("a truncated answer is distinguished from a refused one", async () => {
    let brain!: ClaudeBrain;
    brain = new ClaudeBrain({
      askFn: async () => {
        brain.noteAnswerMeta({ stopReason: "max_tokens", contentBlockTypes: ["text"], outputTokens: 2048, textLength: 7 });
        return '{"decis';
      },
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();

    assert.equal(brain.getStats().truncated, 1);
    assert.equal(brain.getStats().refusals, 0);
    assert.equal(brain.getDeliberations().at(-1)!.answerMeta?.stopReason, "max_tokens");
  });

  test("lifetime counters survive a reset; the per-scenario record does not", async () => {
    const brain = new ClaudeBrain({
      askFn: async () => "not json at all",
      minIntervalMs: 0,
    });
    brain.observe(snap(1000));
    await settle();
    assert.equal(brain.getStats().unparseable, 1);
    assert.equal(brain.getDeliberations().length, 1);

    brain.reset();
    // How the model has behaved is a fact about the model, not about the
    // scenario that happened to be running; what it said about a stream that
    // no longer exists is not.
    assert.equal(brain.getStats().unparseable, 1);
    assert.equal(brain.getDeliberations().length, 0);
  });

  test("describe() identifies the brain for the decision log", () => {
    const brain = new ClaudeBrain({ askFn: async () => "", minIntervalMs: 5_000 });
    assert.match(brain.describe(), /ClaudeBrain/);
  });
});
