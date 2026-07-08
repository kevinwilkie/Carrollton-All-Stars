/*
 * Scoreboard tab — every matchup this week, live.
 */
"use strict";

// This week's matchup cards — shared by the Scoreboard page and the League hub.
function scoreboardCardsHTML() {
  return App.matchups.map((mu) => {
    const mine = mu.home === App.myTeamId || mu.away === App.myTeamId;
    const lead = (mu.homePts ?? 0) === (mu.awayPts ?? 0) ? null : (mu.homePts ?? 0) > (mu.awayPts ?? 0) ? "home" : "away";
    return `<div class="card mu-card${mine ? " is-me" : ""}">` +
      (mu.label ? `<div class="mu-label">${escapeHtml(mu.label)}${mu.final ? " · FINAL" : ""}</div>`
                : mu.final ? `<div class="mu-label">Final</div>` : "") +
      `<div class="mu-teams">` +
      `<div class="mu-side"><div class="name">${lead === "home" ? "▸ " : ""}${escapeHtml(teamName(mu.home))}</div><div class="rec">${teamRecord(mu.home)}</div></div>` +
      `<div class="mu-score">${mu.homePts ?? 0}<span class="vs">vs</span>${mu.awayPts ?? 0}</div>` +
      `<div class="mu-side right"><div class="name">${escapeHtml(teamName(mu.away))}${lead === "away" ? " ◂" : ""}</div><div class="rec">${teamRecord(mu.away)}</div></div>` +
      `</div></div>`;
  }).join("");
}

function renderScoreboard() {
  const host = $("#view-scoreboard");
  if (!App.fs) return host.innerHTML = setupNotice();
  const wk = currentWeek();
  if (!wk) return host.innerHTML = `<div class="empty-note">No scoring week is active.</div>`;
  if (!App.matchups.length) return host.innerHTML =
    `<div class="card"><h3>Week ${wk.n}</h3><p class="hint">No matchups yet — the commissioner generates the schedule from the Admin tab.</p></div>`;

  host.innerHTML =
    `<div class="view-head"><h2>Scoreboard — Week ${wk.n}</h2>` +
    `<span class="pill">${wk.start} → ${wk.end}</span></div>` +
    `<div class="cards">${scoreboardCardsHTML()}</div>`;
}
