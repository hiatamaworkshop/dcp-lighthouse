/**
 * Drive one OTel Demo fault flag on a fixed schedule and write the truth log
 * (H4 / measurement ③). See otel-flag-schedule.ts for why it goes through
 * flagd-ui's API and confirms against flagd.
 *
 *   cd server && npm run build && node dist/run-otel-flag-schedule.js \
 *     --flag paymentFailure --variant 50% --rest 10% --lead 30m --on 10m --off 50m --cycles 23
 *
 * Defaults are those values (≈ 24 h). --rest is the variant between faults: 10%,
 * not off — a payment that never fails gives the curator a zero-variance
 * reference it will not score against (pre-registration revision 2026-10-01 (2)). --base is the Demo's Envoy (default
 * http://localhost:8080). The truth goes to OTEL_DATA_DIR/flags.jsonl.
 *
 * The flag is put to its resting variant (and that logged) before the schedule
 * starts, and again on Ctrl+C — so a run always opens and closes on a known
 * resting state. Don't touch flagd-ui (UI or its scheduler) while this runs: its writes
 * would change flags behind the truth log's back.
 */
import { join } from "node:path";
import {
  appendTruth,
  describeFlag,
  FlagdClient,
  flipAndConfirm,
  parseDuration,
  planFlagSchedule,
} from "./otel-flag-schedule.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const flag = arg("flag", "paymentFailure");
const variant = arg("variant", "50%");
const rest = arg("rest", "10%");
const base = arg("base", "http://localhost:8080");
const steps = planFlagSchedule({
  leadMs: parseDuration(arg("lead", "30m")),
  onMs: parseDuration(arg("on", "10m")),
  offMs: parseDuration(arg("off", "50m")),
  cycles: Number(arg("cycles", "23")),
});
const dir = process.env.OTEL_DATA_DIR ?? join(process.cwd(), "..", "data", "otel");
const client = new FlagdClient(base);

const { resting, restingValue, value } = describeFlag(await client.read(), flag, variant, rest);

async function set(state: "on" | "off"): Promise<void> {
  const target = state === "on" ? variant : resting;
  const r = await flipAndConfirm(client, flag, target);
  appendTruth(dir, {
    ts: r.ts, flag, state, variant: target,
    value: state === "on" ? value : restingValue,
    confirmedTs: r.confirmedTs,
  });
  const lag = r.confirmedTs === null ? "NOT CONFIRMED" : `confirmed +${r.confirmedTs - r.ts} ms`;
  console.log(`${new Date(r.ts).toISOString()} ${flag} → ${target} (${state}) ${lag}`);
  if (r.confirmedTs === null) console.warn(`[flag-schedule] flagd never served ${target}; the truth line says so`);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log("[flag-schedule] stopping: back to the resting variant");
    set("off").finally(() => process.exit(0));
  });
}

await set("off");
const start = Date.now();
const last = steps[steps.length - 1].atMs;
console.log(
  `[flag-schedule] ${flag}: ${steps.length / 2} × ${variant} (value ${JSON.stringify(value)}), ` +
    `ends ${new Date(start + last).toISOString()}; truth → ${join(dir, "flags.jsonl")}`,
);
for (const step of steps) {
  const wait = start + step.atMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (stopping) break;
  await set(step.state);
}
if (!stopping) console.log("[flag-schedule] schedule complete");
