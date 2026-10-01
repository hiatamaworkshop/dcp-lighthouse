import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTruth,
  describeFlag,
  FlagdClient,
  type FlagdConfig,
  flipAndConfirm,
  parseDuration,
  planFlagSchedule,
  withVariant,
} from "./otel-flag-schedule.js";
import { loadFlagTruth } from "./real-data-harness.js";

// Shapes copied from the Demo's src/flagd/demo.flagd.json (858f76f).
const config = (): FlagdConfig => ({
  $schema: "https://flagd.dev/schema/v0/flags.json",
  flags: {
    paymentFailure: {
      defaultVariant: "off",
      state: "ENABLED",
      variants: { "10%": 0.1, "50%": 0.5, "90%": 0.95, off: 0 },
    },
    productCatalogFailure: {
      defaultVariant: "off",
      state: "ENABLED",
      targeting: { if: [{ "==": [{ var: "product_id" }, "OLJCESPC7Z"] }, "off", "off"] },
      variants: { off: false, on: true },
    },
  },
});

describe("flag schedule", () => {
  it("lead OFF, then cycles of ON/OFF at fixed offsets", () => {
    assert.deepEqual(planFlagSchedule({ leadMs: 100, onMs: 10, offMs: 50, cycles: 2 }), [
      { atMs: 100, state: "on" }, { atMs: 110, state: "off" },
      { atMs: 160, state: "on" }, { atMs: 170, state: "off" },
    ]);
    assert.throws(() => planFlagSchedule({ leadMs: 0, onMs: 0, offMs: 1, cycles: 1 }), RangeError);
    assert.throws(() => planFlagSchedule({ leadMs: 0, onMs: 1, offMs: 1, cycles: 0.5 }), RangeError);
    assert.throws(() => planFlagSchedule({ leadMs: NaN, onMs: 1, offMs: 1, cycles: 1 }), RangeError);
  });

  it("parses durations", () => {
    assert.equal(parseDuration("30m"), 1_800_000);
    assert.equal(parseDuration("1.5h"), 5_400_000);
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("250"), 250);
    assert.throws(() => parseDuration("10 minutes"), RangeError);
  });
});

describe("flagd configuration", () => {
  it("names the flags that exist when asked for the pre-rename one, and reads a variant's VALUE, not its label", () => {
    assert.throws(() => describeFlag(config(), "paymentServiceFailure", "50%"), /flags: paymentFailure, productCatalogFailure/);
    assert.throws(() => describeFlag(config(), "paymentFailure", "100%"), /variants: 10%, 50%, 90%, off/);
    assert.throws(() => describeFlag(config(), "paymentFailure", "off"), /resting variant/);
    assert.deepEqual(describeFlag(config(), "paymentFailure", "90%"), { resting: "off", restingValue: 0, value: 0.95 });
  });

  it("rests at an explicit variant (H4 rests at 10%), not at whatever the flag was last left on", () => {
    assert.deepEqual(describeFlag(config(), "paymentFailure", "50%", "10%"), { resting: "10%", restingValue: 0.1, value: 0.5 });
    // A run that died while ON leaves defaultVariant at the fault variant; an explicit rest does not care.
    const leftOn = withVariant(config(), "paymentFailure", "50%");
    assert.deepEqual(describeFlag(leftOn, "paymentFailure", "50%", "10%").resting, "10%");
    assert.throws(() => describeFlag(config(), "paymentFailure", "50%", "5%"), /no variant "5%" to rest at/);
    assert.throws(() => describeFlag(config(), "paymentFailure", "50%", "50%"), /resting variant/);
  });

  it("switches like flagd-ui's Storage: defaultVariant, or the 'then' branch of a ternary targeting; input untouched", () => {
    const c = config();
    const a = withVariant(c, "paymentFailure", "50%");
    assert.equal(a.flags.paymentFailure.defaultVariant, "50%");
    const b = withVariant(c, "productCatalogFailure", "on");
    assert.deepEqual(b.flags.productCatalogFailure.targeting?.if?.slice(1), ["on", "off"]);
    assert.equal(b.flags.productCatalogFailure.defaultVariant, "off");
    assert.deepEqual(c, config());
  });
});

/** A fake Demo: flagd-ui read/write through Envoy, and flagd serving a variant `lag` polls after a write. */
function fakeDemo(o: { lag?: number; resolveStatus?: number } = {}) {
  let stored = config();
  let served = "off";
  let pending: { variant: string; after: number } | undefined;
  const writes: FlagdConfig[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.endsWith("/feature/api/read")) return json({ flags: stored.flags });
    if (u.endsWith("/feature/api/write")) {
      stored = (JSON.parse(String(init?.body)) as { data: FlagdConfig }).data;
      writes.push(stored);
      pending = { variant: stored.flags.paymentFailure.defaultVariant as string, after: o.lag ?? 0 };
      return json({});
    }
    if (u.endsWith("/flagservice/flagd.evaluation.v1.Service/ResolveAll")) {
      if (o.resolveStatus !== undefined) return json({}, o.resolveStatus);
      if (pending !== undefined && pending.after-- <= 0) { served = pending.variant; pending = undefined; }
      // proto3 JSON: a zero value is omitted, so "off" carries no value field.
      return json({ flags: { paymentFailure: served === "off" ? { variant: "off", reason: "STATIC" } : { variant: served, doubleValue: 0.5 } } });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { client: new FlagdClient("http://demo", fetchFn), writes };
}

describe("flip and confirm", () => {
  const clock = () => {
    let t = 1_000;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it("writes through flagd-ui and confirms when flagd serves the variant (by variant — 'off' has no value field)", async () => {
    const demo = fakeDemo({ lag: 3 });
    const c = clock();
    const on = await flipAndConfirm(demo.client, "paymentFailure", "50%", { ...c, pollMs: 100 });
    assert.equal(on.ts, 1_000);
    assert.equal(on.confirmedTs, 1_300);
    assert.equal(demo.writes[0].$schema, "https://flagd.dev/schema/v0/flags.json");
    const off = await flipAndConfirm(demo.client, "paymentFailure", "off", { ...c, pollMs: 100 });
    assert.notEqual(off.confirmedTs, null);
  });

  it("never confirmed within the timeout → confirmedTs null (the flip is still reported, not dropped)", async () => {
    const demo = fakeDemo({ resolveStatus: 503 });
    const r = await flipAndConfirm(demo.client, "paymentFailure", "50%", { ...clock(), pollMs: 1_000, timeoutMs: 5_000 });
    assert.equal(r.confirmedTs, null);
    assert.equal(demo.writes.length, 1);
  });

  it("truth lines written by appendTruth are what the harness reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    appendTruth(dir, { ts: 10, flag: "paymentFailure", state: "off", variant: "off", value: 0, confirmedTs: 20 });
    appendTruth(dir, { ts: 100, flag: "paymentFailure", state: "on", variant: "50%", value: 0.5, confirmedTs: 130 });
    appendTruth(dir, { ts: 700, flag: "paymentFailure", state: "off", variant: "off", value: 0, confirmedTs: 720 });
    assert.deepEqual(loadFlagTruth(dir, "paymentFailure"), [
      { fromTs: 130, toTs: 720, variant: "50%", value: 0.5, confirmed: true },
    ]);
  });
});
