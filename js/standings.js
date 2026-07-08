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
      `<b class="team-link" data-team-view="${t.id}" style="cursor:pointer">${escapeHtml(t.name || t.id)}</b> ` +
      `<span class="sub" style="display:inline">${escapeHtml(t.owner || "")}</span></td>` +
      `<td>${r.w || 0}</td><td>${r.l || 0}</td><td>${r.t || 0}</td>` +
      `<td>${(pct(r) * 100).toFixed(1)}%</td><td>${r.pf || 0}</td><td>${r.pa || 0}</td></tr>`;
  }).join("");

  return `<div class="card"><table class="standings-table">` +
    `<thead><tr><th class="ta-left">Team</th><th>W</th><th>L</th><th>T</th><th>Pct</th><th>PF</th><th>PA</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
}

// Read-only scouting view: any team's roster in the bottom sheet, sorted by
// season points. Rosters are league-readable (firestore.rules), so this works
// for every owner. Wired via a delegated [data-team-view] handler (render.js).
async function openTeamRoster(teamId) {
  const head = `<div class="pc-head">${teamAvatarHTML(teamId, 40)}<div><b>${escapeHtml(teamName(teamId))}</b>` +
    `<div class="sub">${escapeHtml(teamRecord(teamId))}</div></div></div>`;
  openSheet(head + `<div class="empty-note">Loading roster…</div>`, true);
  let roster;
  try { roster = await loadRoster(teamId, true); }
  catch (e) { return openSheet(head + `<p class="hint">Couldn't load this roster.</p>`, true); }
  const players = Object.values(roster.players || {}).map((p) => {
    const live = playerOf(p.mlbId) || {};
    return { ...p, seasonPoints: live.seasonPoints, ilStatus: live.ilStatus, mlbTeam: live.mlbTeam || p.mlbTeam };
  }).sort((a, b) => (b.seasonPoints || 0) - (a.seasonPoints || 0) || (a.name || "").localeCompare(b.name || ""));
  const rows = players.map((p) =>
    `<div class="row">${avatarHTML(p, 28)}<span class="grow"><span class="pl-name">${escapeHtml(p.name)}</span>` +
    `<span class="sub">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
    `${p.ilStatus ? ` <span class="pl-il">${escapeHtml(p.ilStatus)}</span>` : ""}</span></span>` +
    `<span class="val" title="Season fantasy points">${p.seasonPoints != null ? p.seasonPoints : "—"}</span></div>`).join("") ||
    `<div class="empty-note">Empty roster.</div>`;
  openSheet(head + `<div class="pc-sec">Roster · ${players.length}</div><div class="card">${rows}</div>`, true);
}

function renderStandings() {
  const host = $("#view-standings");
  if (!App.fs) return host.innerHTML = setupNotice();
  host.innerHTML =
    `<div class="view-head"><h2>Standings</h2>` +
    `<span class="pill pill-gold">Top ${SEASON_STRUCTURE.playoffTeams} make the playoffs · seeds 1–2 get a bye</span></div>` +
    standingsTableHTML();
}
