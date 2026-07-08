/*
 * Standings tab — records, points for/against, playoff cut line (top 6).
 */
"use strict";

// The sorted standings table as a card — shared by the Standings page and the
// League hub.
function standingsTableHTML() {
  const teams = Object.entries(App.teams).map(([id, t]) => ({ id, ...t }));
  if (!teams.length) return `<div class="empty-note">No teams yet — the commissioner seeds the league from Admin.</div>`;

  const pct = (r) => { const g = (r.w || 0) + (r.l || 0) + (r.t || 0); return g ? ((r.w || 0) + 0.5 * (r.t || 0)) / g : 0; };
  teams.sort((a, b) => pct(b.record || {}) - pct(a.record || {}) || ((b.record || {}).pf || 0) - ((a.record || {}).pf || 0));

  const cut = SEASON_STRUCTURE.playoffTeams;
  const rows = teams.map((t, i) => {
    const r = t.record || { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    return `${i === cut ? `<tr><td colspan="7" class="sub" style="text-align:center;color:var(--gold);font-size:11px;padding:2px">— playoff line —</td></tr>` : ""}` +
      `<tr class="${t.id === App.myTeamId ? "me" : ""}">` +
      `<td class="ta-left"><span class="seed-badge${i < cut ? " playoff" : ""}">${i + 1}</span>` +
      `<b>${escapeHtml(t.name || t.id)}</b> <span class="sub" style="display:inline">${escapeHtml(t.owner || "")}</span></td>` +
      `<td>${r.w || 0}</td><td>${r.l || 0}</td><td>${r.t || 0}</td>` +
      `<td>${(pct(r) * 100).toFixed(1)}%</td><td>${r.pf || 0}</td><td>${r.pa || 0}</td></tr>`;
  }).join("");

  return `<div class="card"><table class="standings-table">` +
    `<thead><tr><th class="ta-left">Team</th><th>W</th><th>L</th><th>T</th><th>Pct</th><th>PF</th><th>PA</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
}

function renderStandings() {
  const host = $("#view-standings");
  if (!App.fs) return host.innerHTML = setupNotice();
  host.innerHTML =
    `<div class="view-head"><h2>Standings</h2>` +
    `<span class="pill pill-gold">Top ${SEASON_STRUCTURE.playoffTeams} make the playoffs · seeds 1–2 get a bye</span></div>` +
    standingsTableHTML();
}
