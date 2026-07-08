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

  if (App.errors.schedule) return host.innerHTML = errorCard("schedule");
  if (!schCache) {
    schCache = {};
    Promise.all(weeks.map((w) => loadWeekSchedule(w.n).then((d) => { schCache[w.n] = d; })))
      .then(renderActive)
      .catch((e) => { schCache = null; dataError("schedule", e); });
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
    `<div class="stack">${playoffBracketHTML(weeks, schCache)}${blocks}</div>`;
  $("#sch-refresh").addEventListener("click", () => { schCache = null; renderActive(); });
}

// A visual QF → SF → Championship bracket from the playoff schedule docs. Slots
// read "TBD" until each round is seeded (the regular-season finalize creates the
// quarterfinals; later rounds fill as weeks finalize). Winners show in gold.
function playoffBracketHTML(weeks, cache) {
  const pw = (weeks || []).filter((w) => w.type === "playoff").sort((a, b) => a.n - b.n);
  if (!pw.length) return "";
  const roundName = ["Quarterfinals", "Semifinals", "Championship"];
  const anyData = pw.some((w) => (((cache || {})[w.n] || {}).matchups || []).length);
  const cols = pw.map((w, i) => {
    const sched = (cache || {})[w.n] || {};
    const mus = sched.matchups || [];
    const items = mus.map((mu) =>
      `<div class="bracket-mu${mu.home === App.myTeamId || mu.away === App.myTeamId ? " is-me" : ""}">` +
      `${mu.label ? `<div class="mu-label">${escapeHtml(mu.label)}</div>` : ""}` +
      `<div class="bracket-team${mu.winner && mu.winner === mu.away ? " won" : ""}">${escapeHtml(mu.away ? teamName(mu.away) : "TBD")}</div>` +
      `<div class="bracket-team${mu.winner && mu.winner === mu.home ? " won" : ""}">${escapeHtml(mu.home ? teamName(mu.home) : "TBD")}</div></div>`).join("")
      || `<div class="empty-note">TBD</div>`;
    const byes = (i === 0 && sched.byes && sched.byes.length)
      ? `<div class="bracket-mu"><div class="mu-label">Byes · seeds 1–2</div>` +
        sched.byes.map((id) => `<div class="bracket-team">${escapeHtml(teamName(id))}</div>`).join("") + `</div>` : "";
    return `<div class="bracket-col"><div class="bracket-round">${roundName[i] || ("Week " + w.n)}</div>${byes}${items}</div>`;
  }).join("");
  return `<div class="card"><h3>Playoff bracket</h3>` +
    (anyData ? "" : `<p class="hint">Seeds and matchups fill in when the regular season ends.</p>`) +
    `<div class="bracket">${cols}</div></div>`;
}
