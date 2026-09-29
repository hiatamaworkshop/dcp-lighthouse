/**
 * Append one fault-injection flag change to the truth log (H4 / measurement ③).
 *
 *   node dist/run-otel-flag-log.js paymentServiceFailure on
 *   node dist/run-otel-flag-log.js paymentServiceFailure off
 *
 * Run it at the moment the flag is flipped (in the OTel Demo's flagd UI or its
 * flagd config). The line carries this machine's wall clock; the truth file is
 * OTEL_DATA_DIR/flags.jsonl, kept apart from the receiver's data on purpose —
 * the replay treats it as ground truth and nothing else writes to it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [flag, state] = process.argv.slice(2);
if (!flag || (state !== "on" && state !== "off")) {
  console.error("usage: run-otel-flag-log <flag> <on|off>");
  process.exit(2);
}
const dir = process.env.OTEL_DATA_DIR ?? join(process.cwd(), "..", "data", "otel");
mkdirSync(dir, { recursive: true });
const line = { ts: Date.now(), flag, state };
appendFileSync(join(dir, "flags.jsonl"), JSON.stringify(line) + "\n");
console.log(`${new Date(line.ts).toISOString()} ${flag} ${state}`);
