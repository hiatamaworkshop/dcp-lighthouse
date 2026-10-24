/**
 * Dashboard client — consumes SSE from DashboardServer.
 * Renders: per-agent pass-rate bars, domain coverage bars,
 * Brain-facing snapshot tiles, decision log, $Q history.
 */

const SSE_URL = "http://localhost:3001/events/snapshot";
const DEC_URL = "http://localhost:3001/events/decisions";
const API     = "http://localhost:3001";

// ── SSE setup ──────────────────────────────────────────────────────────────

const badge = document.getElementById("status-badge");

function connect() {
  const es = new EventSource(SSE_URL);
  es.onopen = () => {
    badge.textContent = "live";
    badge.className = "running";
  };
  es.onerror = () => {
    badge.textContent = "disconnected";
    badge.className = "";
    setTimeout(connect, 3000);
  };
  es.onmessage = (e) => {
    try { renderSnapshot(JSON.parse(e.data)); } catch (_) {}
  };

  const esD = new EventSource(DEC_URL);
  esD.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "replay_snapshot") {
        renderReplayTiles(data.replayPackage);
      } else {
        renderDecisions(data);
      }
    } catch (_) {}
  };
}

connect();

// ── Render snapshot ─────────────────────────────────────────────────────────

function renderSnapshot(data) {
  renderAgents(data.agents ?? []);
  renderDomains(data.domains ?? []);
  renderTiles(data.snapshot);
  renderQHistory(data.qHistory ?? []);
  renderActiveScenario(data.activeScenario ?? null);
  // `=== false`, not falsy: a server that predates the field sends nothing,
  // and that must not read as "stopped".
  stopReminder.hidden = data.streamRunning !== false;
}

// ── Active scenario indicator ────────────────────────────────────────────────

let lastActiveScenario;

function renderActiveScenario(activeScenario) {
  // The Stop banner is driven by `streamRunning` in renderSnapshot, not here:
  // it answers "is the stream stopped", which a scenario change cannot tell.
  // The badge text is restated every tick because the SSE
  // open handler resets this text to a bare "live" on every reconnect, so a
  // label written only on CHANGE would lose the running scenario's name for
  // the rest of that scenario. Only the TEXT is ours — the `running` class is
  // the connection indicator, owned by the open/error handlers above.
  badge.textContent = activeScenario ? `live · ${activeScenario} running` : "live";

  // The button repaint below is a real diff: it walks the DOM, and nothing
  // else writes `active`, so restating it every tick would be pure cost.
  if (activeScenario === lastActiveScenario) return;
  lastActiveScenario = activeScenario;

  for (const btn of document.querySelectorAll("button[data-scenario]")) {
    btn.classList.toggle("active", btn.dataset.scenario === activeScenario);
  }
}

// ── Agent bars ──────────────────────────────────────────────────────────────

function renderAgents(agents) {
  const el = document.getElementById("agent-bars");
  el.innerHTML = "";
  const sorted = [...agents].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const a of sorted) {
    const pct = (a.passRate * 100).toFixed(1);
    const cls = a.passRate >= 0.90 ? "ok" : a.passRate >= 0.75 ? "warn" : "fail";
    el.innerHTML += `
      <div class="agent-row">
        <span class="agent-id">${a.agentId}</span>
        <div class="bar-track">
          <div class="bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
        <span class="rate-label">${pct}%</span>
      </div>`;
  }
}

// ── Domain bars ─────────────────────────────────────────────────────────────

const DOMAIN_WEIGHT = { auth: "critical", payment: "critical", ui: "normal", utils: "low" };

function renderDomains(domains) {
  const el = document.getElementById("domain-bars");
  el.innerHTML = "";
  for (const d of domains) {
    const pct = d.requiredBits > 0 ? Math.min(100, (d.coveredBits / d.requiredBits) * 100) : 0;
    const cls = d.gap > 0 ? "gap" : "";
    const wt = DOMAIN_WEIGHT[d.domain] ?? "low";
    el.innerHTML += `
      <div class="domain-row">
        <span class="domain-label ${wt}">${d.domain}</span>
        <div class="coverage-track">
          <div class="coverage-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="coverage-num">${d.coveredBits}/${d.requiredBits}</span>
      </div>`;
  }
}

// ── Snapshot tiles ──────────────────────────────────────────────────────────

function tileHtml(t) {
  const mag = t.magnitude != null ? `<span class="tile-mag">${t.magnitude.toFixed(1)}σ</span>` : "";
  return `<div class="tile ${t.shapeTag}">
    <div class="tile-label">${mag}${t.label}</div>
    <div class="tile-desc">${t.description}</div>
  </div>`;
}

function renderTiles(pkg) {
  const el = document.getElementById("tiles");
  if (!pkg || !pkg.tiles || pkg.tiles.length === 0) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">No characteristic moments yet.</span>';
    return;
  }
  el.innerHTML = pkg.tiles.map(tileHtml).join("");
}

// ── Replay tiles (fine-window re-observation, ROADMAP L2-3) ─────────────────

function renderReplayTiles(pkg) {
  const el = document.getElementById("replay-tiles");
  if (!pkg || !pkg.tiles || pkg.tiles.length === 0) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">Replay produced no tiles.</span>';
    return;
  }
  el.innerHTML = pkg.tiles.map(tileHtml).join("");
}

// ── Decision log ─────────────────────────────────────────────────────────────

const MAX_DECISIONS = 30;
const decisionLog = document.getElementById("decision-log");

function renderDecisions(data) {
  const decisions = data.decisions ?? [];
  for (const d of decisions) {
    const entry = document.createElement("div");
    entry.className = "decision-entry";
    const ts = new Date(data.ts).toISOString().substr(11, 8);
    entry.innerHTML = `<span class="dtype ${d.type}">${d.type}</span> <span style="color:var(--muted)">${ts}</span><br>${d.reason}`;
    decisionLog.prepend(entry);
  }
  while (decisionLog.children.length > MAX_DECISIONS) {
    decisionLog.removeChild(decisionLog.lastChild);
  }
}

// ── $Q history ───────────────────────────────────────────────────────────────

let lastQLen = 0;
const qFeed = document.getElementById("q-feed");

function renderQHistory(rows) {
  if (rows.length === lastQLen) return;
  lastQLen = rows.length;
  qFeed.innerHTML = [...rows].reverse().slice(0, 15).map((row) => {
    const params = JSON.stringify(row[2]);
    return `<div class="q-row"><span class="scope">${row[1]}</span> ${params}</div>`;
  }).join("");
}

// ── Forecast ($F, ROADMAP_BRIEF.md 2026-10-22 (8), 2026-10-24) ───────────────
//
// A forecast is virtual (2026-10-08): it is drawn dashed and hatched, under a
// "virtual" tag, so it cannot be read as a measurement. The one solid mark is
// the REALIZED window of an earlier forecast, green inside its interval and red
// outside. Polled, not pushed: the rows are made on request from window summaries.

const FORECAST_VIEWS = [
  { view: "coarse", el: "forecast-coarse", pollMs: 5000 },
  { view: "fine",   el: "forecast-fine",   pollMs: 2000 },
];
// Display hint only: the harness's ORDINARY_VOLUME (real-data-harness.ts). The calibration
// of a forecast holds for a window of ordinary volume; outside it the make-up changed.
const ORDINARY_VOLUME = [0.8, 1.25];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pctOf = (x) => `${(x * 100).toFixed(1)}%`;
const clock = (ms) => new Date(ms).toISOString().substr(11, 8);

// The values are pass rates, so [0, 1]; a normal interval around a rate near 1 (or a
// far extrapolation from a young history) spills past it. Drawn clipped, and said so.
const rate01 = (x) => Math.min(1, Math.max(0, x));
function clippedBand(r) {
  const lo = rate01(r.interval.lo);
  const hi = rate01(r.interval.hi);
  return { lo, hi, mean: rate01(r.mean), clipped: r.interval.lo < 0 || r.interval.hi > 1 || r.mean < 0 || r.mean > 1 };
}
const bandText = (b) => `${pctOf(b.mean)} [${(b.lo * 100).toFixed(1)}–${(b.hi * 100).toFixed(1)}]${b.clipped ? ' <span class="fc-flag">clipped to 0–100%</span>' : ""}`;

function forecastAxis(rows, scores) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) { const b = clippedBand(r); lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); }
  for (const s of scores) {
    const b = clippedBand(s.forecast);
    lo = Math.min(lo, b.lo, s.realized.mean);
    hi = Math.max(hi, b.hi, s.realized.mean);
  }
  const pad = Math.max(0.01, (hi - lo) * 0.1);
  lo = Math.max(0, lo - pad);
  hi = Math.min(1, hi + pad);
  if (hi - lo < 0.02) { const mid = (lo + hi) / 2; lo = Math.max(0, mid - 0.01); hi = Math.min(1, mid + 0.01); }
  return { lo, hi, at: (x) => `${(100 * (Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo)).toFixed(2)}%` };
}

function forecastFlags(row) {
  const flags = [];
  if (row.basis.fellBack) flags.push("persistence fallback");
  if (row.basis.extrapolatedFromLag !== undefined) flags.push("young history");
  return flags.length ? ` <span class="fc-flag">${flags.join(", ")}</span>` : "";
}

function forecastRowHtml(r, axis, label) {
  const b = clippedBand(r);
  return `<div class="fc-row">
    <span class="fc-h">${esc(label)}</span>
    <div class="fc-track">
      <div class="fc-int" style="left:${axis.at(b.lo)};width:calc(${axis.at(b.hi)} - ${axis.at(b.lo)})"></div>
      <div class="fc-mean" style="left:${axis.at(b.mean)}"></div>
    </div>
    <span class="fc-num">${bandText(b)}${forecastFlags(r)}</span>
  </div>`;
}

function forecastScoreHtml(s, axis) {
  const r = s.forecast;
  const off = s.volumeRatio < ORDINARY_VOLUME[0] || s.volumeRatio > ORDINARY_VOLUME[1];
  const label = `${r.group !== undefined ? `${r.group} ` : ""}+${r.horizon} · ${clock(r.targetStart)}`;
  const b = clippedBand(r);
  return `<div class="fc-row">
    <span class="fc-h">${esc(label)}</span>
    <div class="fc-track">
      <div class="fc-int" style="left:${axis.at(b.lo)};width:calc(${axis.at(b.hi)} - ${axis.at(b.lo)})"></div>
      <div class="fc-real ${s.insideInterval ? "" : "out"}" style="left:${axis.at(s.realized.mean)}"></div>
    </div>
    <span class="fc-num">forecast ${bandText(b)} → <b>${pctOf(s.realized.mean)}</b> · z ${s.z.toFixed(1)}${
      off ? ` <span class="fc-flag">volume ×${s.volumeRatio.toFixed(2)}</span>` : ""}</span>
  </div>`;
}

function renderForecast(elId, rows, scores) {
  const el = document.getElementById(elId);
  if (rows.length === 0 && scores.length === 0) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">No forecast yet (history still filling).</span>';
    return;
  }
  const axis = forecastAxis(rows, scores);
  const grouped = rows.some((r) => r.group !== undefined);
  const next = rows.map((r) => forecastRowHtml(r, axis,
    `${grouped && r.group !== undefined ? `${r.group} ` : ""}+${r.horizon} · ${clock(r.targetStart)}`)).join("");
  const back = scores.length === 0 ? "" :
    `<div class="fc-sub">earlier forecast vs realized</div>${scores.map((s) => forecastScoreHtml(s, axis)).join("")}`;
  el.innerHTML = `${next}${back}<div class="fc-note">axis ${pctOf(axis.lo)}–${pctOf(axis.hi)} · interval = ${Math.round((rows[0] ?? scores[0].forecast).interval.level * 100)}% · ${esc((rows[0] ?? scores[0].forecast).method)}</div>`;
}

async function pollForecast(v) {
  const el = document.getElementById(v.el);
  try {
    const head = await (await fetch(`${API}/forecast?view=${v.view}`)).json();
    if (head.error) {
      el.innerHTML = `<span style="color:var(--muted);font-size:11px">${esc(head.error)}</span>`;
      return;
    }
    // The realized side: a forecast made two windows ago has its next window whole by now.
    const w = (head.lens.window_ms ?? 1000) * (head.lens.downsample_factor ?? 1);
    const earlier = await (await fetch(`${API}/forecast?view=${v.view}&at=${Date.now() - 2 * w}`)).json();
    renderForecast(v.el, head.rows ?? [], earlier.scores ?? []);
  } catch (_) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">forecast unavailable</span>';
  } finally {
    setTimeout(() => pollForecast(v), v.pollMs);
  }
}

for (const v of FORECAST_VIEWS) pollForecast(v);

// ── Scenario controls ────────────────────────────────────────────────────────

function runScenario(id) {
  fetch(`${API}/demo/start?scenario=${id}`)
    .then(async (res) => {
      // 409 = another scenario is still running. Say so: the click would
      // otherwise look like it did nothing.
      if (res.ok) return;
      const body = await res.json().catch(() => ({}));
      showNotice(body.error ?? `could not start ${id} (HTTP ${res.status})`);
    })
    .catch(console.error);
}

const notice = document.getElementById("notice");
let noticeTimer;

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
}

const stopBtn = document.getElementById("stop-btn");
const stopReminder = document.getElementById("stop-reminder");

function stopGen() {
  // /demo/stop halts the whole stream (baseline included) and cancels any
  // running scenario. The banner goes up now for immediate feedback; the next
  // snapshot's `streamRunning` keeps it up, and a scenario start retracts it.
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping…";
  stopReminder.hidden = false;
  fetch(`${API}/demo/stop`)
    .catch(console.error)
    .finally(() => {
      stopBtn.disabled = false;
      stopBtn.textContent = "Stop";
    });
}

// ── $Q[schema] write surface (ROADMAP L2-1) ──────────────────────────────────

function setBaselineDelta() {
  const input = document.getElementById("baseline-delta-input");
  const value = input.value;
  fetch(`${API}/control/baseline-delta?value=${encodeURIComponent(value)}`).catch(console.error);
}
