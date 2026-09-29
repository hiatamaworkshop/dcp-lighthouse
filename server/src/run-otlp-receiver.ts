/**
 * Long-running OTLP/HTTP (JSON) receiver for H4 (ROADMAP_BRIEF.md 2026-09-27 (3)).
 *
 *   cd server && npm run build && node dist/run-otlp-receiver.js
 *
 * Point the OTel Demo collector's otlphttp exporter at http://localhost:4318
 * with `encoding: json`. Data goes to OTEL_DATA_DIR (default <repo>/data/otel,
 * gitignored), one UTC-day JSONL file plus gaps.jsonl. PORT overrides 4318.
 *
 * Flag flips for the fault-injection truth log are recorded separately by
 * run-otel-flag-log.ts, so the truth has its own clock and cannot be edited by
 * the receiver.
 */
import { join } from "node:path";
import { OtlpReceiver } from "./otlp-receiver.js";

const dir = process.env.OTEL_DATA_DIR ?? join(process.cwd(), "..", "data", "otel");
const port = Number(process.env.PORT ?? 4318);
const receiver = new OtlpReceiver({ dir });
const server = receiver.createServer();
server.listen(port, () => console.log(`[otlp-receiver] listening on :${port}, writing to ${dir}`));

setInterval(() => console.log(`[otlp-receiver] ${JSON.stringify(receiver.stats)}`), 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
