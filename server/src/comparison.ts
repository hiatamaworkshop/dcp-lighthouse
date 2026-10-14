/**
 * The comparison half of a detection — (observation lens, reference lens,
 * comparison), ROADMAP_BRIEF.md 2026-07-25 — resolved from $Q[compare] and run
 * in one place (2026-10-14 (2) item 2, (8)).
 *
 * Before this, every caller of the curator carried its own reference formula
 * (the live view's "the 3 windows before", the replay's "the equal-length span
 * before") and the null model was whatever the one curator had been built
 * with. Both now come from the declared row, and every package says which
 * comparison it came from (SnapshotPackage.comparison) — so once a second
 * reference or null is in use, a tile can still be traced to the one that
 * raised it.
 */

import type { QCompareParams, QObserveParams } from "./q-registry.js";
import { resolveAlign } from "./lens.js";
import { SnapshotCurator, type CurationOptions, type NullModel, type SnapshotPackage } from "./snapshot-curator.js";
import type { ReplaySource, SpanRequest } from "./dashboard.js";

export class Comparator {
  private readonly curators = new Map<NullModel, SnapshotCurator>();

  /** `base` is every curator option except the null, which the row chooses. */
  constructor(private readonly base: Omit<CurationOptions, "nullModel"> = {}) {}

  /** The curator for one null model, built on first use and kept. */
  curatorFor(nullModel: NullModel): SnapshotCurator {
    let c = this.curators.get(nullModel);
    if (c === undefined) {
      c = new SnapshotCurator({ ...this.base, nullModel });
      this.curators.set(nullModel, c);
    }
    return c;
  }

  /**
   * Replay `observation` (an inclusive [fromTs, toTs] request, as
   * ReplaySource.replay reads it) through `lens` and score it under `decl`.
   *
   * "preceding" reference: the span ending just before the observation's first
   * ms, as long as the observation span or `reference_windows` windows of the
   * observation lens. The two spans never share a ms — the replay path used to
   * end its reference AT fromTs, so the event there sat in both.
   *
   * Throws what replay or the curator throw (a lens that only fails at
   * aggregation time — 2026-08-25), and a RangeError for the variogram null on
   * a lens whose grid is not absolute: the variogram reads lags between
   * windows, so observation, reference and any history must share one grid,
   * which only `align:"epoch"` guarantees across separate replays. With or
   * without history — off-phase windows get their lag rounded and γ read at
   * the wrong lag, silently (2026-10-14 (9) review).
   */
  compare(source: ReplaySource, lens: QObserveParams, decl: QCompareParams, observation: SpanRequest): SnapshotPackage {
    const observed = source.replay(lens, observation.fromTs, observation.toTs);
    const refLen =
      decl.reference_windows !== undefined
        ? decl.reference_windows * observed.window_ms
        : observation.toTs + 1 - observation.fromTs;
    const reference: SpanRequest = { fromTs: observation.fromTs - refLen, toTs: observation.fromTs - 1 };
    const referenced = source.replay(lens, reference.fromTs, reference.toTs);

    const nullModel = decl.null_model ?? "independent";
    if (nullModel === "variogram" && resolveAlign(lens) !== "epoch") {
      throw new RangeError(`compare: the variogram null needs an absolute window grid (align:"epoch") so its lags are whole windows`);
    }
    let history: SpanRequest | undefined;
    let historyResult;
    if (decl.history_ms !== undefined) {
      history = { fromTs: reference.fromTs - decl.history_ms, toTs: reference.toTs };
      historyResult = source.replay(lens, history.fromTs, history.toTs);
    }

    const pkg = this.curatorFor(nullModel).curate(observed, referenced, historyResult !== undefined ? { history: historyResult } : {});
    // How much of the requested reference span held events — only this
    // function knows the span it asked for (SnapshotPackage.referenceCoverage).
    // Requests are inclusive, so k windows arrive as k·W ms ending one ms
    // before a boundary (the live view) or k·W + 1 ms ending on it (a replay of
    // [fromTs, fromTs + k·W]); ceil((len − 1) / W) is k for both.
    const expected = Math.max(1, Math.ceil((refLen - 1) / referenced.window_ms));
    const present = referenced.windows.filter((w) => w.count > 0 && w.windowStart < observation.fromTs).length;
    return {
      ...pkg,
      referenceCoverage: Math.min(1, present / expected),
      comparison: {
        reference: { kind: decl.reference ?? "preceding", ...reference },
        nullModel,
        ...(history !== undefined && historyResult !== undefined
          ? { history: { ...history, windowCount: historyResult.windows.length } }
          : {}),
      },
    };
  }
}
