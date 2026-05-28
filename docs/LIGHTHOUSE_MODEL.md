# Lighthouse Model — Observation as a Continuous Stream

## Status

Conceptual design note. Not yet implemented. Captures a thinking pattern that emerged from the Minecraft demo and extends naturally to multi-agent code generation pipelines.

---

## 1. The shift: from fireworks to a lighthouse

Traditional CI/CD treats validation as **a firework**.

```
PR opens  →  tests run once  →  pass/fail  →  done
```

A single event produces a single verdict. The verdict has no temporal shape, no spatial distribution, no agent-of-origin. After the firework, darkness returns until the next PR.

DCP enables a different shape: **a lighthouse**.

```
test events  →  DCP stream  →  $ST observes continuously  →  Brain reads the rotation
```

The beam keeps turning. At any moment, an observer can read the current illumination across the domain. There is no "moment of judgment" — there is only the **current shape of what is lit**.

This is the same architectural shift that event-sourced systems made over request/response: keep the raw events, derive views on demand. DCP applies that pattern to **verification itself**.

## 2. Why this matters now

Code review by human eyes is no longer the limiting factor of safety — the volume of AI-generated code has already passed the threshold where line-by-line review is physically impossible. The honest position taken by senior engineers ("I don't read it anymore") is not negligence; it is the **recognition that the verification layer has moved**.

If humans no longer read every line, *something* must continuously observe the codebase's verification state. That something cannot be event-driven, because the events arrive faster than any judgment cycle. It must be a **stream observer**.

This is exactly what DCP was built for. The Minecraft demo proved DCP can absorb high-frequency game events and let Brain steer the pipeline. The same primitives apply when the events are **test results, coverage deltas, and agent attributions** instead of player moves.

## 3. The model

```
[AI Code Generator A] ─┐
[AI Code Generator B] ─┼─→ test_result:v1 events  ─→  IngestionBus
[AI Code Generator C] ─┘                                    │
                                                            ↓
                                                  [DCP Testor Pipeline]
                                                            │
                ┌───────────────────────────────────────────┼───────────────────────────┐
                ↓                       ↓                   ↓                           ↓
           $ST-time              $ST-area           $ST-agent                    $ST-meta
           temporal map          area heatmap       per-generator vector         observation health
                                                            │
                                                            ↓
                                                       [Brain]
                                                            │
                ┌───────────────────────┬───────────────────┼─────────────────────┐
                ↓                       ↓                   ↓                     ↓
          rerouteSchema          schemaUpdate         quarantineApprove      $Q parameter change
          (problem agent →       (raise coverage     (suppress flaky test    (zoom / shift focus)
           audit pipeline)        target for area)    temporarily)
```

**Note on Brain output.** Only the rightmost arrow (`$Q parameter change`) is something Brain writes directly into DCP. The other three are **signals emitted to an outer interpretation/action layer** (see §4 "4-layer separation"). DCP-side Brain proposes; an external layer (human, separate LLM, ops automation) decides and acts on agent routing, target schemas, and quarantine. This separation is what keeps the inferential layer from mutating system behavior on its own.

### Stream content

Each test execution emits one event:

```
{
  "$schema": "test_result:v1",
  "ts": <execution time>,
  "testId": <stable hash of file::name>,
  "agentId": <which AI session produced the code under test>,
  "areas": [<bit positions of touched code regions>],
  "result": "pass" | "fail" | "flaky",
  "duration": <ms>,
  "weight": <derived from mutation score>,
  "commitHash": <code revision>
}
```

The stream **does not need to be ordered**. Late-arriving events with old `ts` integrate cleanly because $ST is timestamp-driven, not arrival-driven. This is critical when many agents produce in parallel — order cannot be guaranteed, but timestamped events still yield deterministic aggregations.

### Coverage as a vector

Test outcomes are binary (`pass`/`fail`), but **coverage is a vector** in bit-space:

```
coverage_vec[area_bit] = 1   if any passing test covered that area
                       = 0   otherwise

weight_vec[area_bit]   = max(mutation_score across tests touching it)
```

A project's verification state at time `T` is a pair of vectors (`coverage`, `weight`) over the area bit-space. A PR's contribution is the **delta of those vectors** across the PR's window.

This converts "did the tests pass" (event) into "what is the current shape of verified ground" (state). The latter is what Brain needs to make decisions.

### Two reading modes

The same stream supports two reading modes simultaneously:

1. **Window mode** — coverage within a moving time window (last 1h, last 24h). Reveals trends and regression.
2. **Cumulative mode** — coverage against an externally-defined target schema (`$S-area-target`). Reveals **gap to goal**.

```
gap_vec = target_vec XOR cumulative_vec
```

`gap_vec` enumerates unverified ground. The Brain can prioritize agent assignments toward filling it.

## 4. $Q: observation parameters as data

DCP's existing `$O` shadow (see `SHADOW_SYSTEM.md` §$O) handles **output format adaptation** for capability-limited consumers — it converts `$ST` results into bit flags + component vectors so that decoders of varying capability can read the same stream. `$O` writes are *downstream of observation*: they reshape the **output** of `$ST` without changing what `$ST` observes.

The lighthouse model needs the opposite direction. Brain must be able to change **what `$ST` observes in the first place** — window length, decay, group_by, retention, replay policy. These writes are *upstream of observation*: they reshape the **input parameters** of the observation layer.

The two concerns share Brain's authorship but differ in object, direction, and reversibility:

| | `$O` (existing) | `$Q` (this proposal) |
|---|---|---|
| Object | `$ST` output formatting | `$ST` input parameters |
| Direction | downstream of observation | upstream of observation |
| Effect | same observation, different presentation | different observation, different result |
| Reversibility | near-reversible | non-reversible (changing the window changes the answer) |

Folding both into `$O` would violate the SHADOW_SYSTEM.md principle of *single responsibility per shadow*. The lighthouse model therefore introduces `$Q` (Query/Observation Shadow). `$O` and `$Q` are symmetric: `$O` decides how the result is shown, `$Q` decides what the result is. Both are Brain-writable; neither executes logic; both are inspectable shadow rows.

The rest of this section describes the layering inside `$Q`.

### Three layers of observation parameters

Observation parameters do not all live at the same altitude. They form a conceptual stack — referred to in this document as `$Q[pipeline]`, `$Q[observe]`, `$Q[schema]` — but all share one shadow tag (`$Q`) and one row format (see "Row format" below):

| Layer            | Scope                                | Examples                                                      |
|------------------|--------------------------------------|---------------------------------------------------------------|
| `$Q[pipeline]`   | Whole-stream dynamics                | `stream_rate_cap`, `retention_window`, `backpressure_policy`, `replay_mode`, `replay_count` |
| `$Q[observe]`    | `$ST` aggregation shape              | `window_ms`, `decay`, `group_by`, `downsample_factor`, `agg_func` |
| `$Q[schema]`     | Schema-specific thresholds           | `pass_rate_floor`, `critical_weight`, `flaky_threshold`       |

Earlier drafts of this document conflated the three. They are distinct because each operates on a different object, has a different change cost, and is owned by a different part of the runtime. Brain may touch any of them, but each carries different consequences:

- A `$Q[pipeline]` change affects every consumer of the stream. Cheap to declare, expensive in impact. Used sparingly.
- A `$Q[observe]` change reshapes how one schema's statistics look. Used routinely as Brain shifts focus.
- A `$Q[schema]` change adjusts a single threshold. Local. Frequent.

All three live in a dedicated `$Q` registry, all three are written through the same `set()` call, all three appear in the swap-history stream the dashboard renders. The layering is conceptual, not mechanical.

> **Implementation note.** `$Q` does *not* ride on the existing field-mapping layer (`FieldMapping` in `dcp-wrap`). That layer has one clean responsibility — resolving source paths to schema fields — and mixing observation parameters into it would muddy it. `$Q` is its own small registry that `$ST` collectors and the ingestion bus read from. This keeps the "single responsibility per shadow" principle intact down to the implementation.

### Row format

`$Q` follows the same `[tag, scope, body]` shape as `$V`, `$ST`, and `$O`. The layer is encoded as a colon-prefixed selector inside the scope string, mirroring how `$V` uses `"type:..."` / `"range:..."` prefixes:

```
["$Q", "<layer>:<target>", { ...parameters }]

  <layer>  ::= "pipeline" | "observe" | "schema"
  <target> ::= "*"  |  "<schema-id>"  |  "<schema-id>#<view-tag>"
```

This keeps `$Q` as a single shadow with a single `$V` table, while still making `grep '"\$Q", "observe:'` cheap. The `$Q[layer]` notation used elsewhere in this document is shorthand for the three legal scope prefixes.

### Scope boundary — what `$Q` is *not* for

`$Q` is bounded to **the shape of observation itself**: how the pipeline retains, schedules, replays, aggregates, and groups events. Three classes of concern look like observation parameters at first glance, but belong elsewhere. Keeping them out of `$Q` is what prevents the shadow from accreting unrelated responsibilities.

| Concern                                             | Where it belongs                              | Why not `$Q` |
|-----------------------------------------------------|-----------------------------------------------|--------------|
| Reroute, quarantine, target-coverage updates        | Interpretation/action layer (outside DCP)     | These are decisions, not observation lenses (see §4 4-layer separation). |
| Join, projection, output-format selection (TOON / positional / JSON), on-demand partial composition for AI consumption | AI-facing view layer (outside the lighthouse scope) | These shape what AI sees, not what `$ST` measures. A separate boundary layer (`$U` is one plausible name) handles them; treating them here would bleed presentation into observation. |
| Brain's own rule thresholds (e.g. "regression rate > 15% → reroute") | Brain implementation (e.g. `RuleBrain.rules`) | These are how Brain interprets the observed shape, not the shape itself. Storing them in `$Q[schema]` is tempting but conflates measurement with judgment. |

The third row is the tightest call. `$Q[schema]` currently lists `pass_rate_floor` and `flaky_threshold` as examples, and these *are* on the boundary between "a property of the observation" and "a Brain rule." The working rule of thumb: if changing the value changes **what counts as a measurement event** (e.g., the cutoff above which a sample is treated as "flaky" by `$ST`), it belongs in `$Q[schema]`. If changing the value only changes **what Brain decides to do about an already-measured quantity**, it belongs in Brain. Pilot implementations should err on the side of putting these in Brain code first, and only promote to `$Q[schema]` when sharing across Brain implementations becomes necessary.

The intent is to keep `$Q` purely about *the shape of observation*. Decisions, presentations, and judgments live in adjacent layers. This compactness is what makes `$Q` worth introducing as a separate shadow — if it ends up holding everything, it loses its identity.

### What this lets Brain do

Today, window length and aggregation rules are hardcoded in `$ST` collector logic, retention is implicit in memory pressure, and rate limiting is handled outside the observation system entirely. Lifting all of these into shadow data unifies them under one Brain-controllable surface:

```
["$Q", "pipeline:*",                  { "stream_rate_cap": 5000, "retention_window_ms": 3600000 }]
["$Q", "observe:test_result:v1",      { "window_ms": 60000, "decay": "exp(τ=300s)", "group_by": ["agentId","area"] }]
["$Q", "schema:test_result:v1",       { "pass_rate_floor": 0.85 }]
```

### The 4-layer architectural separation

The shadow stack above lives inside a larger separation. Three layers live inside DCP; a fourth lives outside it.

| Layer          | Role                            | Mutability   | Location |
|----------------|---------------------------------|--------------|----------|
| Deterministic  | `$ST` aggregation engine, ingest pipeline | fixed code   | inside DCP |
| Boundary       | `$Q` parameter rows           | data rows    | inside DCP |
| Inferential    | Brain (writes `$Q`, emits signals) | async LLM | inside DCP |
| Interpretation / Action | reads Brain signals + $ST output, decides reroute / quarantine / target updates | human or external LLM | outside DCP |

The aggregation engine never changes — it always applies the parameters it is given. Brain never directly modifies aggregation behavior — it modifies the **parameter rows**, which are inspectable, validatable (`$V` can check ranges), and history-tracked. **Brain's only write surface inside DCP is `$Q` rows.** Reroute decisions, quarantine, and target-schema updates are signals Brain proposes; the interpretation/action layer outside DCP picks them up and acts.

This preserves DCP's core property: **the inferential layer touches only declarative data, never executing logic**. Audit, reproduction, and rollback work the same for observation parameter changes as for any other shadow update. The outer interpretation layer is free to be a person, a rule engine, or another LLM — DCP does not care, because it is bounded by the `$Q` write surface.

### Lighthouse, restated

Given the 4-layer separation, the lighthouse model can be restated compactly: **DCP does not make decisions, it changes how things look.** Data is shaped into the pipeline, circulated, observed through parameterizable lenses, and the resulting statistical shape is emitted. What to do about that shape is the next layer's problem. This framing is the cleanest line between what DCP must guarantee (deterministic aggregation under Brain-controlled lenses) and what it leaves open (action policy, organizational response, downstream automation).

### Patterns Brain can perform

**Zoom** ($Q[observe]) — narrow the window to study micro-structure during an anomaly:
```
normal:  window_ms = 60000   (1 minute)
anomaly: window_ms =  1000   (1 second)
calm:    window_ms = 60000   (restore)
```

**Focus shift** ($Q[observe]) — change the grouping axis to isolate a suspect:
```
normal:    group_by = ["schema"]
suspicion: group_by = ["agentId"]
isolated:  group_by = ["agentId", "area"]
```

**Memory adjustment** ($Q[observe]) — reweight recency to suit the question:
```
trend analysis:   decay = exp(τ=86400s)   (one day half-life)
incident triage:  decay = step(cutoff=now-60s)   (drop everything older than 1 min)
```

**Stream speed control** ($Q[pipeline]) — raise or lower throughput pressure:
```
overload:    stream_rate_cap = 2000  (throttle ingest)
deep dive:   downsample = 1          (keep every event, even at cost of memory)
quiet hours: retention_window_ms = 86400000  (extend memory for tomorrow's analysis)
```

Unlike classical metrics systems, the speed control is **bidirectional**. A classical pipeline can only throttle and downsample (information loss is one-way). DCP retains the raw stream, so Brain can also *raise resolution back up* — restoring a 1-second view of a period that had been aggregated at 1-minute granularity, provided the data still lives within the retention window.

## 5. Stream replay — retroactive re-observation

The patterns in §4 describe Brain changing how a *moving* stream is observed. There is a stronger property: because DCP retains the raw stream for `retention_window_ms`, a past segment can be **re-observed with different `$Q[observe]` parameters, after the fact**, any number of times.

### What replay is — and is not

Replay does **not** make an estimate more accurate by circulating the same data. This must be stated plainly because it is a common misconception: N samples carry N samples' worth of information, and re-reading them does not add information. Variance that appears to "shrink" under naive repetition is an artifact of re-weighting the same evidence, not a gain in precision. A long fixed window or an EWMA achieves time-domain stability more honestly whenever fresh data is flowing.

What replay *does* provide is **retroactive re-observation**: the ability to look at an already-passed time segment through a different lens than the one used when it streamed by. A live pipeline consumes each event once — the window advances, the original aggregation is fixed, and the chance to ask "what did that moment look like at 1-second resolution?" is gone. DCP keeps the raw events inside the retention window, so that question stays answerable. The stream is not consumed by observation — it is read, and can be re-read.

This is the property §4's "raise resolution back up" depends on, made into a first-class operation. EWMA and window-widening cannot do it: once they aggregate, the underlying detail is gone. Replay can, because the detail is still there.

```
["$Q", "pipeline:*", {
  "replay_mode":   "off" | "n_rounds",   // pilot supports these two
  "replay_count":  N                     // re-observation passes over the retained segment
}]
```

The pilot keeps `replay_mode` minimal. A re-observation pass re-runs `$ST` over a retained segment with whatever `$Q[observe]` is currently set — the point is to apply a *new lens* to *old data*, not to iterate toward a "converged" number. Modes that iterate until a statistic settles (`until_convergence`) are intentionally omitted: they would invite the false reading that repetition improves precision. Brain's legitimate request is "re-observe the t=10–40s segment at `window_ms=1000`," not "circulate until the estimate stabilizes."

### Parallel observation overlays

Once replay is cheap, **multiple $ST instances can run on the same stream concurrently**, each with its own `$Q[observe]`:

```
instance A: window=1s,    group_by=[agentId]              ← fine-grained, per-agent
instance B: window=60s,   group_by=[area]                 ← medium, per-region
instance C: window=3600s, group_by=[agentId, area]        ← long, two-axis
```

All three update continuously. Brain does not switch *which* view runs — Brain switches *which view it consults*. The cost of a view switch is the cost of reading a different `$ST` table, not the cost of reconfiguring the pipeline.

This is the DCP interpretation of "multi-angle observation" that classical systems implement through pre-defined dashboard panels. The difference is that DCP can add or remove an angle by writing one `$Q[observe]` row — no schema migration, no historical re-aggregation, because the raw stream is always available.

### Nearest precedent

The honest precedent for retroactive re-observation is **event sourcing**: keep the raw events, derive (and re-derive) views on demand. DCP's replay is event sourcing's replay with one addition — the lens (`$Q[observe]`) is itself Brain-controllable data, so re-derivation can use a *different* aggregation than the original.

It is worth distinguishing replay from the resampling family (bootstrap, MCMC, epoch training, Experience Replay), because the surface resemblance — "use the same data more than once" — invites a wrong analogy. Those techniques re-use data to *characterize or improve an estimator*. DCP's replay re-uses data to *apply a new observation lens*. The first is about the number; the second is about the view. Conflating them is exactly the "repetition improves precision" error warned against above. DCP's replay claims only the second.

The novelty, such as it is, is placement: bringing event-sourcing's re-derivation into a live observation layer whose lens is mutable mid-flight. The math is not new and no precision claim is made.

### Flexibility without losing the past

Classical observation systems force a choice: a long fixed window is stable but blind to recent micro-structure; short adaptive windows are responsive but discard the detail they pass over. DCP sidesteps the dilemma not by circulating data toward a "converged" estimate, but by **keeping the raw segment available**, so:

- **Multiple lenses run at once** — parallel overlays (below) give long- and short-window views simultaneously, and switching which one Brain consults is free.
- **Past detail stays recoverable** — a segment first seen at `window_ms=60000` can be re-observed at `window_ms=1000` later, because the events are still in the retention window.

Neither property comes from re-counting the same evidence. Both come from *not throwing the evidence away*. The controls live in different layers (`$Q[pipeline]` for retention/replay, `$Q[observe]` for lens shape) and do not contend.

### The interactive observation loop

Retroactive re-observation earns its place not as a statistical trick but as the mechanism behind a control loop in which **the observer adjusts the lens and looks again**:

```
$ST presents the current shape  →  Brain reads the shape  →
Brain judges "this drop needs finer resolution"  →  Brain sets $Q[observe] (e.g. window_ms 60000 → 1000)  →
the retained segment is re-observed under the new lens  →  a new shape returns  →  Brain reads again
```

This loop is the operational heart of the lighthouse model. Each step already exists in §4–§5 — present a shape, change `$Q`, re-observe a retained segment — but their *composition* is what makes the model more than a configurable metrics system. The observer is not passively fed a fixed dashboard; it interrogates the data by changing how it looks and asking the same past to answer differently.

Two design facts make the loop viable, both grounded in how an LLM observer actually reasons (see `LIGHTHOUSE_PILOT_DATA.md` §12):

- **The shape, not the raw series, is what Brain reads.** An LLM reconstructs trend and inflection from a numeric list at high cost and low reliability; it reads a *shape* (a rendered or summarized form) directly. So the loop's "present" step must emit shapes, not rows. This is a presentation concern, handled by the AI-facing view layer (`$U`, see §6.5), not by `$ST` itself.
- **The lens change is cheap and reversible.** Because re-observation reads retained data, Brain can try a lens, dislike it, and try another, without disturbing live ingestion or losing the ability to go back to the original view.

What replay contributes to this loop is the guarantee that **"look again, differently" is always available** for anything inside the retention window. Without retained raw data the loop collapses into "look once, accept the first aggregation." With it, observation becomes interactive.

> Footnote: because `$Q` rows are themselves data, `$ST` could in principle observe Brain's own parameter changes (a meta-observation layer counting `$Q` mutations, change targets, and post-change effect on pass-rate). Noted only because the architecture admits it; out of scope for the pilot and not pursued further in this document.

## 6. Application: AI code generation pipeline

The lighthouse model gives multi-agent code generation a verification substrate that doesn't require human pacing.

### Stream sources

```
[Jest/Vitest hooks]     ─┐
[pytest hooks]          ─┼─→ TestorAdapter ─→ test_result:v1 ─→ IngestionBus
[gcov / coverage.py]    ─┘
```

`TestorAdapter` is to test runners what `BukkitAdapter` is to Minecraft events: a normalizer that converts runner-specific output into DCP packets. Implementation effort is small; the per-runner adapter knows only how to extract `(testId, areas, result, duration)`.

### `bitpos` — the new primitive

The one piece that does not exist in current tooling is `bitpos(area_descriptor) → area_id`, the mapping from "a region of code" to a position in the coverage representation. Three reasonable starting points:

1. **AST coordinate**: `file:function:branch` → stable hash → id. Fully automatic, fine-grained, but the id-space is large and most ids are uninteresting.
2. **Annotated regions**: developers tag critical regions with `// @area: payment.charge`. Coarse, manual, but matches human intuition about what matters.
3. **Brain-curated regions**: start with AST coordinates, let Brain merge / split regions over time based on observed bug clustering. The region definition itself becomes data in `MappingLayer`.

Production systems will likely combine all three. Early implementations should start with option 1 plus selective option 2.

### Representation: tag set, not raw bit index

The pilot uses a fixed 256-bit area space (see `LIGHTHOUSE_PILOT_DATA.md` §4) because it makes heatmaps readable. Production should not. Raw bit indices break when the area dictionary is versioned across organizations — bit 17 in v3 of someone else's dictionary is not bit 17 in yours. The production representation is a **tag set with dotted hierarchy**:

```
areas_touched: ["auth", "auth.login", "session", "db.users"]
```

Tags are looked up against a versioned dictionary distributed as a DCP shadow row (e.g. `["$Q", "area-dictionary:<version>", { ... }]`). Aggregation rolls tags up to their hierarchy parents at display time. This costs slightly more in $ST than bit-AND operations, but removes the bit-compatibility problem entirely and makes dictionary updates non-breaking.

### Area dictionary as a community artifact

The area dictionary is the lighthouse model's main social dependency. Each domain (REST APIs, payment systems, ML training pipelines, CLI tools) needs a starting vocabulary of regions, and that vocabulary is most useful when shared. Three plausible paths:

1. **Per-organization private dictionaries** — each company curates its own. Lowest coordination cost, no network effect.
2. **Industry-vertical dictionaries** — fintech, healthtech, etc., maintained by consortia. Mirrors how OpenAPI specifications already cluster.
3. **Open dictionaries on a public repository** — OSS-style governance, versioned, PR-reviewed. Long-term most valuable but requires seed momentum.

The expectation is that some kind of collective curation emerges, because AI-generated code increasingly converges on a small set of structural patterns. The structural side is what dictionaries describe; business semantics remain domain-specific. The lighthouse project's scope is **the dictionary format and a seed dictionary**, not running the dictionary registry.

### `areas_touched` vs `areas_failed`

A test event tells the pipeline what regions a test execution touched, but does not directly tell it which region *caused* a failure. The pilot intentionally stops at:

```
areas_touched: [...]   // every region the test exercised — known from coverage instrumentation
result: "pass" | "fail" | "flaky"
```

`areas_failed` (the regions most likely responsible for a failure) is **inferred outside DCP**, by the interpretation layer, from assertion messages, recent commit diffs, and historical failure patterns. Putting failure attribution into the event schema would require ground truth the test runner does not have. Keeping it out preserves the rule that DCP only ingests what the source actually knows.

### `weight` is provisional

`weight` in the event schema (see §3 above) is reserved for a quality signal — mutation score being the canonical candidate. But mutation testing is computationally expensive: each mutant requires a near-full test suite run, and continuous mutation testing is out of reach for most projects today. The pilot fixes `weight = 1.0`. Production deployments should treat `weight` as a `weight_source`-tagged value:

```
weight_source: "uniform" | "mutation" | "assertion_count" | "property_based" | "manual"
```

This lets each deployment choose what its `weight` actually means, and lets the interpretation layer decide how much to trust it. The lighthouse model does **not** require mutation score to work — it requires only that `weight_source` be honestly declared.

### Brain rules (illustrative)

```
if (area = auth_module) and (coverage_delta < 0 over 24h):
    schemaUpdate: target_coverage[auth_module] += 0.1
    rationale: "auth coverage regressing — raise target to attract agent attention"

if (agent = AI-C) and (regression_rate > 15% over 7d):
    rerouteSchema: AI-C output → audit-pipeline
    rationale: "AI-C produces regressions at 3x the baseline rate"

if (testId = X) and (flaky_rate > 30% over 1h):
    quarantineApprove: testId = X
    rationale: "X is unreliable — exclude until root cause identified"
```

These are direct translations of GameRuleBrain patterns from the Minecraft demo. The Brain implementation is domain-specific, but the DCP plumbing (PostBox, MappingLayer, $ST collectors) is unchanged.

### What this enables

The cultural shift "I don't read AI code" becomes operationally supportable when **the lighthouse is always rotating**. The reviewer's question shifts from "is this diff correct?" (unanswerable at scale) to "is the verification state of the affected area within tolerance?" (a single $ST query).

This is not a replacement for human judgment on **architectural** or **design** decisions — those remain outside the verification vector, by their nature. It is a replacement for the line-by-line correctness check that humans were never reliably performing anyway.

## 6.5. Scope: what the lighthouse fits, and what it doesn't

The lighthouse model is well-suited to event streams where (a) events arrive frequently enough to support statistics, (b) each event is cheap enough to retain in the replay window, and (c) events are localized to regions in the area space. Unit tests satisfy all three naturally. Lightweight integration tests usually do. End-to-end tests, acceptance tests, and manual QA do not.

| Test layer | Frequency | Cost per event | Area localization | DCP fit |
|---|---|---|---|---|
| Unit | high | low | tight | ◎ |
| Integration | medium | medium | medium | ○ |
| E2E | low | high | broad | △ |
| Acceptance / manual | sporadic | high | unclear | × |

The pilot targets the unit-test layer. E2E and acceptance flows have legitimate verification needs but call for a different architecture (closer to a "fixed camera" — low frequency, high information per event, individual analysis) and are out of scope for the lighthouse pilot.

### Test/code collusion is observable, not solvable

When the same agent both writes code and writes its tests, the tests can be silently weak in ways that pass coverage. The lighthouse model does not propose to *prevent* this. It proposes to **make it visible**. If event events carry separate `code_author` and `test_author` fields (deferred — see §scope below), $ST can split pass-rate by same-author vs cross-author pairs. A collusion regime shows as an anomalously high same-author pass rate. Whether to act on that — by reassigning test authorship, by adding adversarial test agents, or by raising the auth target — belongs to the interpretation layer.

The pilot defers `code_author` / `test_author` separation and uses a single `agentId` field. Multi-agent semantics are added when there is demand for the analysis above, not preemptively.

### AI-facing view layer is out of scope

The lighthouse model deliberately stops at *observable state*. Composing that state into views for AI consumption — joining decomposed flat streams back into nested forms on demand, projecting subsets, selecting an output format (TOON, positional array, JSON), constructing partial views in response to a query — is a separate concern. The working name for this layer is `$U` (UI / view shadow); the lighthouse pilot does not implement or specify it.

Keeping this layer out of `$Q` is deliberate. `$Q` controls what the pipeline *measures*; the view layer controls what is *shown to consumers*. When data has nested structure, the DCP-side answer is to *decompose into flat streams with ID linkage*, observe each independently, and let the view layer reconstruct nested shapes only when a specific consumer requests them. The LLM-facing end of this boundary is the territory MNP (§7) occupies in its simplest form — a text representation the LLM edits. `$U` would be the systematic version of that end, fed by observed streams rather than a single GUI's state. The lighthouse model touches only the system-internals side; `$U` and the MNP-style edit interface are downstream concerns that can evolve independently.

For the pilot, the test event schema is flat by construction (one schema, no nesting), so the *join* aspect of the view layer does not bite. But one `$U` responsibility is not optional even in the pilot, because the interactive observation loop (§5) depends on it: **presenting `$ST` output as shapes the LLM can read, and curating which moments to show.**

The loop's "present" step cannot hand Brain a raw numeric series — an LLM reconstructs trend from numbers poorly. `$U` is where statistics become legible form. The pilot's findings on LLM observers (`LIGHTHOUSE_PILOT_DATA.md` §12) point to a specific shape for this: not a live animated chart, but a **snapshot package** — a small set of still images (or shape summaries) of characteristic and exceptional moments, each carrying a label and the exact numbers for its region. The reference image is early-AI training displays: a grid of independently-readable, labeled samples, compared at a glance. An LLM reads such a package far better than it reads either a number list or a continuously animating graph (an LLM perceives motion as sampled frames anyway, so animation gives it little that well-chosen stills do not).

Snapshot curation places a *mechanical* judgment in `$U`: which moments are "characteristic" (inflection, regime change) or "exceptional" (threshold breach, high variance). The line to hold is that `$U` selects on statistically self-evident criteria only — it picks what *stands out*, it does not decide what it *means*. Semantic judgment ("this is a regression") stays in Brain. `$U` is the curator that hangs the striking frames; Brain is the interpreter that reads them.

Format, join, and query-driven composition remain genuinely deferred. Shape presentation and snapshot curation are the part of `$U` the pilot must touch, because without them the §5 loop has nothing to present.

### Stance: concept demonstration, not production system

The pilot is not engineered for production. It exists to show that the lighthouse model's distinctive properties — observation-parameter changes as data, retroactive re-observation of retained segments, multi-axis $ST aggregation under Brain-controlled lenses, and the interactive observation loop that ties them together — can be made visible on a realistic-looking stream. Production-readiness (large-scale ingestion, fault tolerance, real test-runner adapters, fine-grained `bitpos`) is acknowledged but explicitly out of scope. The artifact is a thinking tool for the AI-development era as much as a piece of code.

## 7. Relationship to adjacent ideas

The lighthouse model rhymes with several independently emerging patterns. Listing them clarifies what is and isn't novel here.

- **TOON** (Token-Oriented Object Notation) — recognizes that JSON's per-row key repetition wastes LLM tokens. Solves the same problem as `$S` but only inside LLM contexts. Validates the "schema is separate from data" insight.
- **MNP** (中間記法パターン) — places a text DSL between GUI state and LLM, so the LLM edits the DSL instead of the GUI. This is the *simplest instance* of the boundary-layer pattern, reached from a design (GUI-editing) angle rather than a systems one. It names and packages a practice that DSL-driven tools (Mermaid, PlantUML, structure editors) have used for decades, now applied to LLMs — useful as a name to discuss, but not a new primitive. It stops at the single edit interface: no schema/data separation (the DSL is in-band, like TOON/JSON), no observation layer, no stream, no control loop. The reported 4–8× token reduction is real for repetitive UI state but context-dependent, not a general property. It is listed here because it shows the "put a boundary representation between system and LLM" intuition is spreading — but the spread currently stops well short of schema externalization and observation.
- **Event sourcing** — keeps raw events, derives views on demand. The lighthouse model is event sourcing applied specifically to **verification state**.
- **Observability platforms** (Prometheus, Grafana) — already stream metrics continuously, but operate on infrastructure signals, not verification signals, and lack a control loop fed back into the system under observation.

The lighthouse model's contribution is not any single primitive — it is the **composition**: timestamped verification events in a stream, multi-axis $ST aggregation, `$Q`-controlled observation shape (with `$O` adapting the output), retroactive re-observation of retained segments, the interactive loop in which Brain reads a shape and re-observes under a new lens, and the explicit recognition that this is the substrate multi-agent development requires.

## 8. Implementation notes

This document does not propose immediate implementation. The current DCP wrap is sized for the Minecraft demo. Building TestorAdapter, the three-layer $Q shadow, and the replay mechanism are separate workstreams.

The order is split into two phases. **Phase 0** validates the domain-independent core mechanism on a known-truth stream; **Phase 1** applies it to the code-verification domain. The split exists because the test domain mixes mechanism bugs with domain-modeling plausibility — see `LIGHTHOUSE_PILOT_DATA.md` §1.5.

**Phase 0 — core mechanism (Minecraft baseline + hand-authored anomalies)**

The reference stream is the existing Minecraft demo's events (a natural distribution, already wired from ingestion through `$ST`); anomalies are injected by hand so their ground truth is known. The four core properties validated here are domain-independent: **retroactive re-observation, dynamic dataset addition, observation-tuning interruption, and the Brain-facing observation UI.**

1. **`$Q[observe]` parameters** — small change to `$ST` collectors to read window/decay/group_by from a dedicated `$Q` registry instead of constructor constants. (`StCollector` currently fixes `windowMs` at construction with no runtime setter — this step adds the dynamic read.) The smallest concrete win.
2. **`$Q[pipeline]` retention and replay control (retroactive re-observation)** — formalize the retention window as a shadow row (raw events kept), add replay-mode reading to `$ST` collectors. `n_rounds` only — a replay pass re-observes a retained segment under whatever `$Q[observe]` is set. *Correctness is checked numerically: a localized structure (injected burst) that a coarse window averages away must reappear when the same retained segment is re-observed at a finer window, matching the aggregate the recorded injected truth predicts for that lens. This is a detail-recovery check, **not** a variance-shrinking-by-repetition check (see §5).*
3. **Parallel `$ST` overlays + tuning interruption** — allow multiple collector instances on the same stream with distinct `$Q[observe]` rows; verify that view switching is a read-only operation and that changing `$Q` mid-stream reshapes the live view without restarting ingestion. **Dynamic dataset addition** (injecting a new source into the running stream) is exercised here too.
3b. **Brain-facing observation UI** — the snapshot-package presentation (see `LIGHTHOUSE_PILOT_DATA.md` §12) that makes tuning changes and anomalies visually separable, and lets re-observation add a new tile. Built against the Phase 0 stream where the truth is known, so "the re-observed shape matches the injected truth" can be confirmed against the recorded ground truth.

**Phase 1 — code-verification domain**

4. **`TestorAdapter`** — for a single test runner (Vitest or pytest). Stream events to a separate IngestionBus instance.
5. **`bitpos`** — AST coordinates only. Defer annotation and Brain-curation modes.
6. **One Brain rule** — e.g., regression-rate-based reroute. Validates the loop closes.
7. **Dashboard panel** — coverage heatmap drawn from $ST output. The public-facing artifact.

Each step is independently demonstrable. Phase 0 (steps 1–3b) extends the Minecraft demo with no code-domain dependencies and validates the mechanism against known truth. Phase 1 (steps 4–7) re-skins the validated stream into `test_result:v1`; because the mechanism is already trusted, Phase 1 questions only the domain representation.
