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
    try { renderDecisions(JSON.parse(e.data)); } catch (_) {}
  };
}

connect();

// ── Render snapshot ─────────────────────────────────────────────────────────

function renderSnapshot(data) {
  renderAgents(data.agents ?? []);
  renderDomains(data.domains ?? []);
  renderTiles(data.snapshot);
  renderQHistory(data.qHistory ?? []);
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

function renderTiles(pkg) {
  const el = document.getElementById("tiles");
  if (!pkg || !pkg.tiles || pkg.tiles.length === 0) {
    el.innerHTML = '<span style="color:var(--muted);font-size:11px">No characteristic moments yet.</span>';
    return;
  }
  el.innerHTML = pkg.tiles.map((t) => {
    const mag = t.magnitude != null ? `<span class="tile-mag">${t.magnitude.toFixed(1)}σ</span>` : "";
    return `<div class="tile ${t.shapeTag}">
      <div class="tile-label">${mag}${t.label}</div>
      <div class="tile-desc">${t.description}</div>
    </div>`;
  }).join("");
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

// ── Scenario controls ────────────────────────────────────────────────────────

function runScenario(id) {
  fetch(`${API}/demo/start?scenario=${id}`).catch(console.error);
}

function stopGen() {
  fetch(`${API}/demo/stop`).catch(console.error);
}
