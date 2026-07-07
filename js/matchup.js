/*
 * Matchup tab — my head-to-head for the current week: live totals, day-by-day
 * points, and each side's scorers (from the precomputed score docs).
 */
"use strict";

let muScores = {};   // teamId -> score doc for the current week
let muLoading = false;

async function ensureMatchupData(home, away, week) {
  if (muLoading) return;
  muLoading = true;
  try {
    await loadPlayers();
    muScores[home] = await loadScore(home, week, true);
    muScores[away] = await loadScore(away, week, true);
  } finally { muLoading = false; }
  renderActive();
}

function weekPlayerTotals(score) {
  const totals = {};
  const capped = new Set();
  Object.values((score && score.byPlayerDays) || {}).forEach((day) => {
    Object.entries(day || {}).forEach(([id, d]) => {
      totals[id] = Math.round(((totals[id] || 0) + (d.points || 0)) * 10) / 10;
      if (d.cappedStart) capped.add(id);
    });
  });
  return { rows: Object.entries(totals).sort((a, b) => b[1] - a[1]), capped };
}

function renderMatchup() {
  const host = $("#view-matchup");
  if (!App.fs) return host.innerHTML = setupNotice();
  const wk = currentWeek();
  if (!wk) return host.innerHTML = `<div class="empty-note">No scoring week is active.</div>`;
  const mu = App.matchups.find((m) => m.home === App.myTeamId || m.away === App.myTeamId);
  if (!mu) return host.innerHTML =
    `<div class="card"><h3>Week ${wk.n}</h3><p class="hint">You don't have a matchup this week` +
    `${wk.type === "playoff" ? " (bye or eliminated)" : " — has the schedule been generated?"}.</p></div>`;

  const hs = muScores[mu.home], as = muScores[mu.away];
  if (!hs || !as) { ensureMatchupData(mu.home, mu.away, wk.n); }

  const side = (teamId, score) => {
    const wt = weekPlayerTotals(score);
    const rows = wt.rows.slice(0, 30).map(([id, pts]) => {
      const p = playerOf(id) || { name: "#" + id, positions: [] };
      return `<div class="row">${avatarHTML(p, 26)}` +
        `<span class="grow"><span class="pl-name">${escapeHtml(p.name)}</span>` +
        `<span class="sub">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
        `${wt.capped.has(id) ? ` <span class="il-flag">start over ${PITCHING.maxStartsPerWeek}-cap · scored 0</span>` : ""}</span></span>` +
        `<span class="val">${pts}</span></div>`;
    }).join("") || `<div class="empty-note">No points yet.</div>`;
    const days = Object.entries((score && score.byDay) || {}).sort()
      .map(([d, v]) => `<div class="row"><span class="grow sub">${fmtDay(d)}</span><span class="val">${v}</span></div>`).join("");
    const starts = score && score.startsUsed != null
      ? ` · ${score.startsUsed}/${PITCHING.maxStartsPerWeek} starts` : "";
    return `<div class="card"><h3>${escapeHtml(teamName(teamId))} — ${(score && score.total) || 0}${starts}</h3>` +
      `${rows}<div class="divider-rule">By day</div>${days || `<div class="empty-note">—</div>`}</div>`;
  };

  host.innerHTML =
    `<div class="view-head"><h2>Week ${wk.n}${mu.label ? " · " + escapeHtml(mu.label) : ""}</h2>` +
    `<button class="btn btn-ghost btn-small" id="mu-refresh">↻ Refresh</button></div>` +
    `<div class="card mu-card">` +
    `<div class="mu-teams">` +
    `<div class="mu-side"><div class="name">${escapeHtml(teamName(mu.home))}</div><div class="rec">${teamRecord(mu.home)}</div></div>` +
    `<div class="mu-score">${mu.homePts ?? 0}<span class="vs">vs</span>${mu.awayPts ?? 0}</div>` +
    `<div class="mu-side right"><div class="name">${escapeHtml(teamName(mu.away))}</div><div class="rec">${teamRecord(mu.away)}</div></div>` +
    `</div></div>` +
    `<div class="mu-detail-cols" style="margin-top:14px">${side(mu.home, hs)}${side(mu.away, as)}</div>`;

  const r = $("#mu-refresh");
  if (r) r.addEventListener("click", () => { muScores = {}; renderActive(); });
}
