/*
 * League tab — the league home: this week's scoreboard + the standings, with
 * quick links to the detailed pages that live in the ☰ menu. Composes the
 * shared scoreboardCardsHTML() and standingsTableHTML() helpers, so it stays
 * in sync with those pages automatically.
 */
"use strict";

function renderLeague() {
  const host = $("#view-league");
  if (!App.fs) return host.innerHTML = setupNotice();
  const wk = currentWeek();

  const links =
    `<div class="league-links">` +
    `<button class="tc-link" data-goto="scoreboard">📊 Scoreboard</button>` +
    `<button class="tc-link" data-goto="schedule">🗓️ Schedule</button>` +
    `<button class="tc-link" data-goto="transactions">📋 Transactions</button>` +
    `<button class="tc-link" data-goto="trades">🔁 Trades</button>` +
    `</div>`;

  const scoreboard = App.matchups.length
    ? `<div class="divider-rule">This week${wk ? " · Week " + wk.n : ""}</div>` +
      `<div class="cards">${scoreboardCardsHTML()}</div>`
    : "";

  const standings = `<div class="divider-rule">Standings</div>${standingsTableHTML()}`;

  host.innerHTML = `<div class="view-head"><h2>League</h2></div>${links}${scoreboard}${standings}`;
  host.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.goto)));
}
