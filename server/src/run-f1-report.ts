/**
 * F1, periodic references, on the collected Wikimedia stream (ROADMAP_BRIEF.md
 * 2026-10-14 (2) item 3). Exploration only: every collected day has been seen;
 * spent holdout days may be read (labelled in the output), an unspent one may not
 * (stage1RangeRefusal).
 *
 *   cd server && npm run build && node dist/run-f1-report.js --from 2026-10-06 --to 2026-10-10
 *
 * H3's arm (60 s windows, 60 min spans) through one contrast scorer under the
 * variogram null (runContrastDiurnal), with three references: the span before
 * (the control), the same span a day earlier, and the difference in
 * differences. The first day and a half of the range only feed history and the
 * day-earlier references. Per reference: the package alarm rate and H3's
 * diurnal correlation on the null, then the detection rate for shifts of the
 * observation's second half (`--deltas`, in bot share).
 */
import { join } from "node:path";
import { loadWikiDir, runContrastDiurnal, spentHoldoutNote, stage1RangeRefusal } from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const historyHours = Number(arg("history-hours") ?? 36);
const deltas = (arg("deltas") ?? "0.01,0.02,0.04").split(",").map(Number);
if (fromDay === undefined || toDay === undefined || !(historyHours > 0) || deltas.some((d) => !Number.isFinite(d))) {
  console.error("usage: run-f1-report --from YYYY-MM-DD --to YYYY-MM-DD [--history-hours 36] [--deltas 0.01,0.02,0.04]");
  process.exit(2);
}
const refusal = stage1RangeRefusal(fromDay, toDay, process.argv.includes("--holdout"));
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}

const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");
const stream = await loadWikiDir(dir, { fromDay, toDay });
console.log(`${stream.events.length} events, ${stream.gaps.length} collection gaps (${fromDay}…${toDay}), history ${historyHours} h`);
const spentNote = spentHoldoutNote(fromDay, toDay);
if (spentNote !== undefined) console.log(spentNote);

const base = { spanMs: 3_600_000, windowMs: 60_000, historyMs: historyHours * 3_600_000, strideMs: 600_000 };
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

console.log("\n— null (60 s windows, 60 min spans, variogram contrast; exploration)");
console.log("reference      trials  alarm   r(rate, slope)  unscored windows");
for (const r of runContrastDiurnal(stream, base)) {
  console.log(
    `${r.reference.padEnd(14)} ${String(r.trials).padStart(6)}  ${pct(r.flagged / Math.max(1, r.trials)).padStart(6)}  ` +
      `${r.correlation.toFixed(3).padStart(14)}  ${r.unscoredWindows}` + (r.blindByGap > 0 ? `  (${r.blindByGap} trials blind or short of history)` : ""),
  );
}

console.log("\n— detection: the observation's second half shifted by delta");
console.log(`reference      ${deltas.map((d) => `δ ${d}`.padStart(9)).join("")}`);
const byDelta = deltas.map((d) => runContrastDiurnal(stream, { ...base, injectDelta: d }));
for (let k = 0; k < byDelta[0].length; k++) {
  console.log(`${byDelta[0][k].reference.padEnd(14)} ${byDelta.map((rs) => pct(rs[k].flagged / Math.max(1, rs[k].trials)).padStart(9)).join("")}`);
}
