/*
 * Schedule tab — all 24 weeks (21 regular + 3 playoff), with the current week
 * highlighted. Playoff slots show as TBD until the bracket advances.
 */
"use strict";

let schCache = null;

function renderSchedule() {
  const host = $("#view-schedule");
  if (!App.fs) return host.innerHTML = setupNotice();
  const weeks = (App.settings && App.settings.weeks) || [];
  if (!weeks.length)
    return host.innerHTML = `<div class="card"><h3>Schedule</h3><p class="hint">No week map yet — the commissioner sets it up on the Admin tab.</p></div>`;

  if (!schCache) {
    schCache = {};
    Promise.all(weeks.map((w) => loadWeekSchedule(w.n).then((d) => { schCache[w.n] = d; })))
      .then(renderActive);
    return host.innerHTML = `<div class="empty-note">Loading schedule…</div>`;
  }

  const cur = currentWeek();
  const blocks = weeks.map((w) => {
    const sched = schCache[w.n];
    const mus = (sched && sched.matchups) || [];
    const rows = mus.map((mu) => {
      const mine = mu.home === App.myTeamId || mu.away === App.myTeamId;
      return `<div class="row${mine ? "" : " dim"}"><span class="grow">` +
        `${mu.label ? `<span class="mu-label">${escapeHtml(mu.label)}</span> ` : ""}` +
        `<b>${escapeHtml(mu.away ? teamName(mu.away) : "TBD")}</b> @ <b>${escapeHtml(mu.home ? teamName(mu.home) : "TBD")}</b>` +
        `</span></div>`;
    }).join("") || `<div class="empty-note">${w.type === "playoff" ? "Bracket TBD." : "Not generated yet."}</div>`;
    const byes = sched && sched.byes && sched.byes.length
      ? `<div class="sub" style="padding:4px 6px">Byes: ${sched.byes.map(teamName).map(escapeHtml).join(", ")}</div>` : "";
    return `<div class="card week-block${cur && cur.n === w.n ? " is-me" : ""}">` +
      `<div class="week-title"><h3>Week ${w.n}${w.type === "playoff" ? " · Playoffs" : ""}</h3>` +
      `<span class="dates">${w.start} → ${w.end}</span></div>${rows}${byes}</div>`;
  }).join("");

  host.innerHTML = `<div class="view-head"><h2>Schedule</h2>` +
    `<button class="btn btn-ghost btn-small" id="sch-refresh">↻ Refresh</button></div>` +
    `<div class="stack">${blocks}</div>`;
  $("#sch-refresh").addEventListener("click", () => { schCache = null; renderActive(); });
}
