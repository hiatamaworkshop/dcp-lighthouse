# Lighthouse Pilot — Mock Data Requirements

## Status

Specification for the mock stream that drives the lighthouse model pilot. Implementation has not started.

Companion to `LIGHTHOUSE_MODEL.md`. That document defines the concept; this one defines the data the pilot will use to demonstrate the concept.

---

## 1. Why mock data first

The lighthouse model targets test event streams from real test runners, but the pilot deliberately defers real-runner integration. Reasons:

- **Adapter work is heavy and incidental** — writing a Vitest/Jest/pytest adapter is significant effort that does not validate the lighthouse model itself. The adapter can be added after the pilot demonstrates value.
- **Anomalies are hard to provoke on demand** — to show "Brain detects agent regression," we need a stream where agent regression actually happens, on cue, with controlled magnitude. Real test suites do not cooperate.
- **Reproducibility matters for demo video** — a recorded scenario must be deterministic. Real test runs are not.

Mock data lets us specify the exact stream shape needed to exercise every claim in `LIGHTHOUSE_MODEL.md`. Once the observation layer works on mock data, real adapters become a plug-in replacement of the source.

The Minecraft demo followed the same pattern (`demo-scenario.ts` injects synthetic events to provoke each pipeline behavior). The lighthouse pilot is the same shape, in the code-verification domain.

## 1.5. Two-phase validation — core mechanism before domain

The `test_result:v1` domain (§2 onward) is the *destination*, not the starting point. The test domain carries difficulties that interfere with validating the core observation mechanism:

- The `areas` coverage vector has no canonical construction rule, so any mock bit-setting is arguable.
- The natural distribution of real pass/fail/flaky outcomes is unknown, so a mock's noise model cannot be judged "realistic."
- A mechanism bug and an unrealistic domain mock are hard to tell apart when both can produce a wrong-looking statistic.

These mix *mechanism correctness* with *domain modeling plausibility*. The pilot separates them into two phases.

### Phase 0 — re-observation correctness on a known-truth stream

The core lighthouse properties — **retroactive re-observation, dynamic dataset addition, observation-tuning interruption, and the Brain-facing observation UI** — are domain-independent. They are validated *first*, on a stream whose statistics are known, before any test-domain semantics are introduced.

The Phase 0 stream uses the **existing Minecraft demo events as the reference baseline** (a natural, non-contrived distribution that is already wired from ingestion through `$ST`) with **hand-authored anomalies injected on top**. This combination is deliberate:

- The Minecraft baseline supplies a *natural* normal distribution — no artificial normality to defend.
- The injected anomaly supplies a *known ground truth* — at injection time the harness holds the exact perturbation (e.g., "source-C mean shifted 0.5 → 0.3 from t=10s", or "a 1-second failure burst at t=5s").
- Correctness is then checkable *numerically*: re-observing the retained segment at a given `$Q[observe]` must produce the aggregate the injected truth predicts for that lens. A coarse window over a localized burst should average it out; a fine window over the same retained data should surface it. The check is "does the re-observed shape match what this lens should show, given the known truth?" — not "does repetition shrink variance" (it does not; see `LIGHTHOUSE_MODEL.md` §5).

The validation harness **must record every injected truth** (baseline distribution + injection delta + injection timing), so that the expected aggregate *under each lens* can be computed and compared against the re-observed result.

The three pilot scenarios (§6 AR / CG / RC) are, stripped of domain vocabulary, pure statistical phenomena and can be exercised in Phase 0:

- **AR** ≡ a source's value distribution shifts (visible across lenses — it is in the data).
- **CG** ≡ a channel receives no events (a hole that persists across aggregation depths).
- **RC** ≡ a localized burst hidden by a coarse lens is recovered by re-observing the retained segment at a finer lens.

### Phase 1 — domain skinning onto `test_result:v1`

Only after Phase 0 confirms the mechanism does the pilot re-skin the validated stream into `test_result:v1`: `sourceId → agentId`, `channel → area`, value-distribution → pass/fail/flaky, and the `areas` coverage vector (§2–§4). Because the mechanism is already trusted, Phase 1 asks only whether the *domain representation* is plausible — the two difficulties no longer mix.

The rest of this document (§2 onward) specifies the Phase 1 `test_result:v1` domain. Phase 0 reuses the same scenario structure and the same `$Q` observation parameters; only the event schema and the source of the baseline differ.

## 2. Event schema

The single packet type the pilot ingests:

```typescript
type TestEvent = {
  $schema:    "test_result:v1"
  ts:         number              // unix millis
  testId:     string              // stable hash, e.g. "auth::reject_expired_token"
  agentId:    string              // "agent-A" | "agent-B" | "agent-C" | "agent-D"
  areas:      number[]            // bit positions in area-space (see §4)
  result:     "pass" | "fail" | "flaky"
  duration:   number              // ms
  weight:     number              // 0.0..1.0, derived from mutation score
  commitHash: string              // 7-char hex
}
```

Notes on each field:

- `ts` is set by the generator at emission time. Late-arrival mixing (an old `ts` arriving after a newer one) is **explicitly part of test scenarios** because it exercises DCP's timestamp-driven aggregation.
- `testId` is stable across runs of the same test, so the per-test flaky-rate aggregation makes sense.
- `agentId` identifies the synthetic AI generator that "wrote the code under test." Four agents is enough for visible multi-agent dynamics without crowding the dashboard.
- `areas` is a list of bit positions in the area bit-space (§4). One test typically touches 2–8 areas. **Pilot uses raw bit indices for readability; production representation is a tag set** — see `LIGHTHOUSE_MODEL.md` §6 "Representation: tag set, not raw bit index." Within the pilot, `areas` is always *touched* areas (every region the test exercised), never *failed* areas (which would require attribution the runner cannot provide). Failure attribution is the interpretation layer's job.
- `result` includes `flaky` as a first-class state because flaky-test storms are one of the scenarios.
- `weight` is reserved for future quality-signal integration. **In the pilot, `weight` is fixed at 1.0 and should not be relied on for any visible behavior.** A real deployment would carry a `weight_source` tag (`"uniform" | "mutation" | "assertion_count" | ...`) so the interpretation layer knows how much to trust it. Mutation score is one option among several, not the model's foundation.
- `commitHash` is decorative in the pilot but reserved so dashboards can correlate events to "PRs."
- `agentId` is a single field in the pilot. Production schemas may split into `code_author` / `test_author` to make collusion analysis possible (see `LIGHTHOUSE_MODEL.md` §6.5), but multi-agent semantics are deferred until there is a concrete need.

## 3. Agent population

Four synthetic agents, with distinct behavioral profiles:

| AgentId   | Profile                                        | Purpose in pilot                       |
|-----------|------------------------------------------------|----------------------------------------|
| `agent-A` | Baseline competent. ~95% pass, low flaky       | Reference signal                       |
| `agent-B` | Coverage-broad but shallow. Touches many areas, occasionally fails | Tests area-axis aggregation |
| `agent-C` | Quality regression candidate. Pass rate drops on demand | Triggers reroute scenario             |
| `agent-D` | Flaky producer. Occasionally emits flaky tests | Triggers quarantine scenario           |

Profiles are realized by the generator's per-agent probability distributions. They are not hardcoded fates — scenarios can override (e.g., a "recovery" scenario where agent-C returns to baseline).

## 4. Area bit-space

The pilot uses a fixed 256-bit area space, partitioned by domain weight:

```
bit 0   – 31  →  "auth"      weight = critical
bit 32  – 63  →  "payment"   weight = critical
bit 64  – 127 →  "ui"        weight = normal
bit 128 – 255 →  "utils"     weight = low
```

A "domain" is a contiguous bit range. A test event's `areas` field lists individual bits (not ranges); aggregation rolls them up to domains for display.

This is not a real AST mapping. It is a fixed virtual area space sized to make heatmaps readable in the dashboard. Real `bitpos` from AST coordinates is a later workstream, and even then the **production representation is a tag set, not raw bit indices** (see `LIGHTHOUSE_MODEL.md` §6). The pilot's bit-space is a demonstration aid, not a recommended deployment shape.

The four-domain breakdown (auth / payment / ui / utils) doubles as the **seed dictionary** for an E-commerce-flavored example. This is deliberate: the critical/normal/low gradient is most legible in domains where money or identity is at stake, which is also where the "AI wrote it, humans don't read it" risk feels most concrete.

### Target schema

The cumulative-coverage view (§3 of LIGHTHOUSE_MODEL.md) compares observed coverage to an external target:

```
target_coverage_bits = {
  "auth":    all 32 bits required
  "payment": all 32 bits required
  "ui":      48 of 64 bits required (some bits "don't care")
  "utils":   32 of 128 bits required (low-priority)
}
```

This target lives in `MappingLayer` and can be modified by Brain (the "schemaUpdate" decision raises a target's required-bit count).

## 5. Stream baseline

Independent of any scenario, the pilot's stream has a **continuous baseline** so the observation layer always has data to chew on. Baseline parameters:

```
rate:        ~50 events / second
agent mix:   25% each (uniform)
result mix:  93% pass, 5% fail, 2% flaky
area mix:    weighted toward critical domains (auth/payment touched more often)
duration:    ~30ms ± 15ms (normal-ish distribution)
```

Baseline runs forever in the background. Scenarios overlay perturbations on top.

## 6. Scenarios

Each scenario is a finite perturbation injected on top of the baseline, modeled on Minecraft's `Scenario A-D` structure. The pilot ships with **three scenarios**, deliberately small — each exercises a distinct claim from `LIGHTHOUSE_MODEL.md` and avoids overlap. The baseline (Scenario N from earlier drafts) is not a numbered scenario because it runs continuously underneath everything.

### Scenario AR — Agent Regression

- Starting at t=10s, agent-C's pass rate drops from 95% to 70%
- Sustained for 30 seconds
- **Expected observation**: $ST-agent shows agent-C diverging from peers
- **Expected Brain action**: `rerouteSchema` — agent-C's output to an "audit" pipeline
- **Demonstrates**: per-agent observation + Brain reroute decision. This is the multi-agent core of the lighthouse model.

### Scenario CG — Coverage Gap

- A specific cluster of `auth` bits (e.g., bits 16–23) never appears in any test event
- Sustained for 30 seconds
- **Expected observation**: $ST-area heatmap shows a black band in auth
- **Expected Brain action**: `schemaUpdate` — raise target-coverage attention or emit a gap alert
- **Demonstrates**: cumulative-coverage view + interaction with externally-defined target schema. Shows that "what was not tested" is as observable as "what was tested."

### Scenario RC — Retroactive re-observation

- A 10-second segment that, viewed live at a coarse window (`window_ms=60000`), looks like an uneventful flat band — the coarse lens averages away a brief internal structure (e.g. a 1-second burst of failures around t=5s).
- After the segment has passed, Brain re-observes it from the retention buffer at a finer window (`replay_mode: n_rounds`, re-run with `window_ms=1000`).
- **Expected observation**:
  - Coarse live view: flat, structure invisible.
  - Fine re-observation of the same retained data: the t≈5s burst becomes visible.
- **Expected Brain action**: on noticing the coarse band sits near a threshold, Brain re-observes the segment at finer resolution to check what the coarse lens hid.
- **Demonstrates**: the lighthouse model's most distinctive property — **retroactive re-observation**. The same past data answers differently under a different lens, because the raw events are retained. This is *not* a claim that repetition reduces variance (see `LIGHTHOUSE_MODEL.md` §5); it is that detail averaged away by a coarse window is recoverable while the data lives in the retention buffer — something EWMA and window-widening cannot do.

### Scenarios omitted from the initial pilot

The following were considered and deferred. They are valid scenarios but each duplicates evidence already provided by AR/CG/RC, so they add demo length without adding new claims.

- **FS (Flaky Storm)** — mechanism similar to AR but on testId axis instead of agent axis.
- **CR (Coverage Regression Trend)** — the time-axis trend behavior is implicitly demonstrated by AR and CG when shown with multiple window sizes.
- **N (Normal-only)** — the baseline runs underneath every scenario, so "quiet pipeline" is visible in the gaps between scenarios.

If a later iteration shows that AR/CG/RC under-sell some capability, these are the next candidates.

### Scenario composition

Scenarios are independent and run sequentially in the default demo mode (one after another, returning to baseline between). Overlapping execution (e.g., AR + CG simultaneously) is supported by the generator API but not used in the recorded demo for clarity.

## 7. Late-arrival behavior

DCP's claim that ts-driven aggregation tolerates out-of-order arrival must be exercised. The generator includes a `late_arrival_rate` parameter (default 0% in scenarios above, 5–10% in a dedicated stress test) that:

- Buffers some events for 0.5–3 seconds before emission
- Their `ts` reflects the *original* intended time
- Aggregation results must be **identical** to the in-order run

This is a correctness test rather than a Brain-action scenario. The dashboard reflects no visible difference — that *is* the demonstration.

## 8. Mock dimensions intentionally omitted

The following are **not** in the pilot, deliberately:

- **Real `bitpos`** from AST coordinates — fixed virtual area space only.
- **Tag-set area representation** — pilot uses raw bit indices for dashboard readability; production uses tags + versioned dictionary (see `LIGHTHOUSE_MODEL.md` §6).
- **Mutation score / `weight_source` tagging** — `weight` is fixed at 1.0; quality-signal selection is a real-adapter concern.
- **`areas_failed` attribution** — only `areas_touched` is recorded; failure attribution is the interpretation layer's job.
- **`code_author` / `test_author` split** — single `agentId` only; collusion analysis and multi-agent assignment are deferred.
- **Action layer** — Brain emits proposals (reroute, quarantine, schemaUpdate). Acting on them belongs to an outer interpretation layer (human, separate LLM, or rule engine). The pilot logs proposals but does not actually reroute streams or quarantine tests.
- **Upstream-test schemas** — only unit-test-like events. E2E and acceptance flows fit poorly with stream replay (low frequency, high cost, broad area touch) and need a different architecture.
- **Cross-test dependencies** — tests are independent events in the pilot.
- **Test runner specifics** — no Vitest/Jest/pytest semantics leak in.
- **Code under test** — events have a `commitHash` but no associated code; we are demonstrating the observation layer, not running real verification.

Each omission is recoverable once a real adapter is built. None block the pilot's demonstration goals.

## 9. Generator API

The mock generator exposes a small surface:

```typescript
interface MockStreamGenerator {
  start(opts?: { rate?: number, lateArrivalRate?: number }): void
  stop(): void
  runScenario(id: "AR" | "CG" | "RC"): Promise<void>
  setAgentProfile(agentId: string, profile: AgentProfile): void
  getCurrentLoad(): { eventsPerSec: number, activeScenario: string | null }
}

interface AgentProfile {
  passRate: number
  flakyRate: number
  areasPerTest: { min: number, max: number }
  domainBias?: Record<string, number>   // weighting per domain
}
```

This mirrors `ScenarioRunner` in Minecraft's `demo-scenario.ts`. A REST endpoint (`/demo/start?scenario=AR`) wraps it for dashboard-driven recording, also mirroring Minecraft.

## 10. Validation criteria

The pilot is considered to demonstrate the lighthouse model when **all three scenarios** produce their expected $ST observations and Brain actions, deterministically, across repeated runs. Specifically:

1. **Scenario AR**: agent-C reroute decision emitted within 5 seconds of regression onset. Per-agent panel must visually separate agent-C from peers within the same window.
2. **Scenario CG**: gap visible in heatmap within 10 seconds. Target-update decision emitted if the gap persists beyond the configured threshold.
3. **Scenario RC**: a structure (injected burst) that is invisible in the coarse-lens view becomes visible when the same retained segment is re-observed at a finer lens. Concretely: the coarse-window aggregate over the burst region is within tolerance of the surrounding baseline (structure averaged away), while the fine-window re-observation of the *same retained data* surfaces the burst at its known location and magnitude. The check is a presence/recovery test against the recorded injected truth, run deterministically across repeated runs — explicitly **not** a variance-reduction-by-repetition claim (see `LIGHTHOUSE_MODEL.md` §5). Re-observation must be Brain-initiated, not pre-scripted.

Baseline behavior: between scenarios, the pipeline runs at ~50 events/sec with no Brain decisions emitted. The visual quiet during this period is part of the demonstration.

Late-arrival stress: aggregation identical (within numerical tolerance) to in-order baseline. This is a correctness test run separately, not part of the recorded demo.

## 11. Brain implementation

### Brain's write surface is bounded

Before the implementation note: Brain's only direct write surface inside DCP is `$Q` parameter rows (`pipeline:` / `observe:` / `schema:` scopes — see `LIGHTHOUSE_MODEL.md` §4 "Row format"). Reroute / quarantine / target-update decisions are **proposals emitted to an outer interpretation/action layer** (see `LIGHTHOUSE_MODEL.md` §4 "4-layer separation"). The pilot records these proposals to a log and surfaces them on the dashboard, but does not execute them — there is no real stream to reroute and no real test to quarantine. This bounded write surface is what makes the LLM-Brain audit problem tractable: even a misbehaving Brain can only reshape the *view*, never the data or the system under observation.

Brain's own rule thresholds (e.g., "regression rate > 15% → emit reroute proposal") live in **Brain code, not in `$Q[schema]`**. The distinction is intentional: `$Q[schema]` is for thresholds that affect what `$ST` counts as a measurement event; Brain rule thresholds are for how Brain interprets an already-measured quantity. The pilot keeps Brain rules in `rule-brain.ts` and promotes a value to `$Q[schema]` only if a second Brain implementation needs to read the same threshold. See `LIGHTHOUSE_MODEL.md` §4 "Scope boundary" for the rule.

### Implementation

The pilot ships a **rule-based Brain** modeled directly on Minecraft's `GameRuleBrain`. Reasoning:

- Minecraft demonstrated that rule-based Brain is sufficient to drive interesting pipeline behavior; the Claude variant added little for the demo's purposes.
- A rule-based Brain is deterministic, which matters for reproducible scenario validation.
- Pilot effort is better spent on observation-layer correctness than on LLM Brain quality.

However, **replacement must be designed in from the start**. The implementation exposes:

```typescript
interface BrainAdapter {
  observe(snapshot: STSnapshot): void
  decide(): BrainDecision[]   // called per tick
  describe(): string          // for logging
}
```

The pilot ships `RuleBrain implements BrainAdapter`. A later `ClaudeBrain implements BrainAdapter` can plug in via configuration (`BRAIN_MODE=claude`) without touching the rest of the pipeline. This mirrors the pattern already validated in Minecraft.

## 12. Presentation — shapes for two different observers

A guiding note for how observation output is presented, kept here so it is not lost when implementation begins. The key finding is that **the human observer and the LLM observer want different things**, and conflating them leads to the wrong default (an animated dashboard for everyone).

### Two observers, two presentations

The lighthouse model has a behavior ordinary line charts hide: **when observation parameters change, the picture changes; when the stream itself becomes anomalous, the picture deforms in characteristic ways**. The aim is that an observer can tell normal from abnormal by the shape, and tell apart "the world changed" from "I changed how I look at it." That much is common to both observers. How to deliver it differs.

**Human observer — live, shape-oriented display.** A continuously updating view (oscilloscope / spectrogram / radial — aesthetic is secondary) suits human perception, which reads motion and rhythm directly. The human watches the lighthouse turn.

**LLM observer (Brain) — snapshot package, not animation.** This is the finding that reshapes the design. An LLM does not perceive a live graph the way a human does; it samples a clip as a few still frames and infers motion from them. So animation delivers little to an LLM that well-chosen stills do not. What an LLM reads well is:

- **A shape (still image or shape summary), not a number list** — it grasps "stable, then a cliff at t≈3, then high variance" from a picture immediately, but reconstructs the same from `[0.95,0.94,0.93,0.71,...]` slowly and unreliably.
- **Characteristic and exceptional moments, pre-selected and labeled** — an LLM's attention skews to the ends of a long series and misses gradual mid-series change. Having the observation layer *pick* the moments that stand out and lay them side by side compensates for this directly.
- **Shape plus the exact numbers for the region** — the picture directs attention; the numbers confirm magnitude. An LLM reads the cliff from the image, then takes the precise post-cliff value from the attached numbers. Shape alone under-determines magnitude; numbers alone are slow to read. The pair is best.

The reference image is an early-AI training display: a grid of independently-readable, labeled samples compared at a glance. For the lighthouse pilot, the LLM-facing artifact is therefore a **snapshot package** — a small set of (image-or-shape-summary + label + region numbers) tiles covering the characteristic and exceptional moments of the observed window — not a GIF.

### How this connects to the observation loop

The snapshot package is the "present" step of the interactive observation loop (`LIGHTHOUSE_MODEL.md` §5). When Brain sees a suspicious tile and wants finer detail, it changes `$Q[observe]` (e.g. shrinks the window) and the relevant segment is **re-observed**, producing a *new tile* added to the package — not a regenerated animation. Snapshot curation and shape rendering are `$U` responsibilities (`LIGHTHOUSE_MODEL.md` §6.5); `$U` selects what stands out on mechanical criteria, Brain interprets what it means.

### Scenarios under this treatment

- **AR (agent regression)** — a per-agent tile where one agent's shape diverges from peers. The divergence persists across window sizes (it is in the data), distinguishing it from a lens change.
- **CG (coverage gap)** — a per-area tile with a hole that persists through aggregation-depth changes (the hole is in the data, not the lens).
- **RC** — note the corrected framing: the RC tile shows that a noisy segment, **re-observed at a finer window**, reveals micro-structure the coarse window averaged away. It does **not** claim variance shrinking from repetition (see `LIGHTHOUSE_MODEL.md` §5 "What replay is — and is not").

### Validation hook

Because the LLM-facing presentation is itself a design claim ("shapes help Brain decide better than numbers"), Phase 1 should test it: run the same anomaly past Brain with (a) a number list only and (b) a snapshot package, and compare decision accuracy and latency. Keep only the presentation features that measurably help — do not add tile types on intuition. This mirrors the empirical stance taken on §10's RC threshold.

Implementation is deferred until the data layer works. The note exists so that, when the time comes, the default for the LLM-facing side is a curated snapshot package, and the animated chart is recognized as the human-facing side — two artifacts, not one.

## 13. Open questions

To be resolved before implementation:

- **Persistence**: does the pilot need to survive restart? Recommendation: no, in-memory only. The Minecraft demo is also memory-resident.
- **Dashboard panels**: minimum panel set is informed by §12 but the data-layer-first order means panels come later. Recommendation: defer until $ST output shape is known.
- **Replay implementation depth**: `n_rounds` (re-observation passes) only. Convergence-style modes are *not* planned — they would imply the false "repetition improves precision" reading (see `LIGHTHOUSE_MODEL.md` §5). Replay's pilot role is retroactive re-observation under a new lens, nothing more.

Resolved during design discussion (recorded here for traceability):

- **Area representation in pilot vs production**: pilot keeps raw 256-bit space for dashboard readability; production uses tag-set + versioned dictionary. Resolved in `LIGHTHOUSE_MODEL.md` §6.
- **`areas_failed` in event schema**: not included. `areas_touched` only; attribution belongs to the interpretation layer.
- **`weight` semantics**: fixed at 1.0 in pilot. Production uses a `weight_source` tag; mutation score is one option, not the foundation.
- **`agentId` granularity**: single field. `code_author` / `test_author` split deferred until multi-agent analysis is concretely needed.
- **Brain write surface**: `$Q` rows only. Reroute / quarantine / target updates are proposals to the outer layer, not direct Brain actions.
- **Test layer in scope**: unit-test-like events. E2E and acceptance flows fit poorly and are out of scope.
- **What replay claims**: retroactive re-observation of retained data under a new lens — *not* variance reduction by repetition. The earlier "replay for stability" framing is corrected in `LIGHTHOUSE_MODEL.md` §5. Replay's value is realized through the interactive observation loop.
- **LLM-facing presentation**: a curated snapshot package (shape + label + region numbers), not an animated chart. Animation is the human-facing artifact. Reason: an LLM samples animation as still frames and reads shapes + numbers better than either alone (§12).
- **Two-phase validation**: core mechanism validated first on Minecraft baseline + hand-authored anomalies with known ground truth (Phase 0), then re-skinned to `test_result:v1` (Phase 1). See §1.5.

## 14. Next steps

Document is stabilized and the project structure exists. Remaining work is implementation, in the order specified in `LIGHTHOUSE_MODEL.md` §8 (Phase 0: core mechanism on Minecraft baseline → Phase 1: `test_result:v1` domain). The immediate next action is Phase 0 Step 1 — making `$ST` collectors read `$Q[observe]` from a dedicated `$Q` registry in `dcp-wrap` (not the existing `FieldMapping` layer, which stays single-purpose), validated against the existing Minecraft demo without breaking its tests.
