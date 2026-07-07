/*
 * Admin tab (commissioner only) — league setup + overrides:
 *   · Seed league: create the 12 team docs from shared/league-config.js
 *   · Week map: pull season dates from the MLB API, review, save
 *   · Schedule: generate the 21-week round robin + playoff placeholders
 *   · Overrides: FAAB adjustments, force-executing/vetoing trades
 * Scheduled jobs run on Netlify — test-fire them from the Netlify UI
 * (Logs → Functions → select → "Test run"); results land here next refresh.
 */
"use strict";

function renderAdmin() {
  const host = $("#view-admin");
  if (Auth.role !== "commish") return host.innerHTML = `<div class="empty-note">Commissioner only.</div>`;
  if (!App.fs) return host.innerHTML = setupNotice();

  const weeks = (App.settings && App.settings.weeks) || [];
  host.innerHTML =
    `<div class="view-head"><h2>Commissioner Tools</h2></div>` +
    `<div class="admin-grid">` +

    `<div class="card"><h3>1 · Seed league</h3>` +
    `<p class="hint">Creates/updates the 12 team documents from <code>shared/league-config.js</code> ` +
    `(names, owner emails, $${FAAB.budget} FAAB). Safe to re-run — records are preserved.</p>` +
    `<button class="btn" id="ad-seed">Seed teams</button></div>` +

    `<div class="card"><h3>2 · Week map</h3>` +
    `<p class="hint">${weeks.length ? `${weeks.length} weeks configured (${weeks[0].start} → ${weeks[weeks.length - 1].end}).`
      : "No weeks yet."} Build from the MLB ${LEAGUE.season} calendar, review the JSON, then save.</p>` +
    `<button class="btn btn-ghost" id="ad-build-weeks">Build from MLB calendar</button>` +
    `<textarea id="ad-weeks" rows="6" style="width:100%;margin-top:8px;font-family:monospace;font-size:11px">${escapeHtml(JSON.stringify(weeks, null, 1))}</textarea>` +
    `<div id="ad-weeks-notes" class="hint"></div>` +
    `<button class="btn" id="ad-save-weeks" style="margin-top:8px">Save week map</button></div>` +

    `<div class="card"><h3>3 · Schedule</h3>` +
    `<p class="hint">Generates the ${SEASON_STRUCTURE.regularWeeks}-week balanced round robin ` +
    `(10 opponents twice, 1 once) with playoff placeholders. Regenerating mid-season would orphan results — only run before Opening Day.</p>` +
    `<button class="btn" id="ad-gen-schedule">Generate schedule</button></div>` +

    `<div class="card"><h3>FAAB override</h3>` +
    `<p class="hint">Set a team's remaining FAAB (trade compensation, corrections).</p>` +
    `<select id="ad-faab-team">${LEAGUE_TEAMS.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select>` +
    `<input type="number" id="ad-faab-amt" min="0" step="1" placeholder="$" style="width:90px;margin-left:6px" />` +
    `<button class="btn btn-small" id="ad-faab-save" style="margin-left:6px">Set</button></div>` +

    `<div class="card"><h3>Trades override</h3>` +
    `<p class="hint">Force-execute or kill a pending trade right now.</p><div id="ad-trades">` +
    App.trades.filter((t) => ["proposed", "accepted"].includes(t.status)).map((t) =>
      `<div class="row"><span class="grow">${escapeHtml(teamName(t.from))} ⇄ ${escapeHtml(teamName(t.to))} <span class="sub">${t.status}</span></span>` +
      `<button class="btn btn-small" data-force="${t.id}">Execute</button>` +
      `<button class="btn btn-danger-ghost btn-small" data-kill="${t.id}">Veto</button></div>`).join("") ||
    `<div class="empty-note">No pending trades.</div>` +
    `</div></div>` +

    `<div class="card"><h3>Scheduled jobs</h3>` +
    `<p class="hint">ingest-stats (every 30 min) · daily-rollover (~3am ET: waivers, eligibility, lineups) · ` +
    `hourly-tick (trades). Watch or test-run them in the Netlify dashboard → Logs → Functions.</p></div>` +

    `</div>`;

  $("#ad-seed").addEventListener("click", adminSeed);
  $("#ad-build-weeks").addEventListener("click", adminBuildWeeks);
  $("#ad-save-weeks").addEventListener("click", adminSaveWeeks);
  $("#ad-gen-schedule").addEventListener("click", adminGenSchedule);
  $("#ad-faab-save").addEventListener("click", adminSetFaab);
  host.querySelectorAll("[data-force]").forEach((b) => b.addEventListener("click", () => adminTrade(b.dataset.force, "executed")));
  host.querySelectorAll("[data-kill]").forEach((b) => b.addEventListener("click", () => adminTrade(b.dataset.kill, "vetoed")));
}

async function adminSeed() {
  try {
    const batch = App.fs.batch();
    LEAGUE_TEAMS.forEach((t) => {
      batch.set(L().collection("teams").doc(t.id), {
        name: t.name, owner: t.owner, ownerEmail: t.email,
        faabRemaining: FAAB.budget,
      }, { merge: true });
    });
    batch.set(L().collection("config").doc("settings"), {
      season: LEAGUE.season, scoring: SCORING,
      tradeReviewHours: TRADE.reviewHours, vetoesNeeded: TRADE.vetoesNeeded,
      faabBudget: FAAB.budget, keeperMax: KEEPER.max,
    }, { merge: true });
    await batch.commit();
    toast("League seeded.", "success");
  } catch (e) { toast("Seed failed: " + e.message, "error"); }
}

async function adminBuildWeeks() {
  const notes = $("#ad-weeks-notes");
  notes.textContent = "Fetching MLB season dates…";
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/seasons/${LEAGUE.season}?sportId=1`);
    const data = await res.json();
    const s = (data.seasons || [])[0] || {};
    const built = ScheduleGen.buildWeekMap({
      openingDay: s.regularSeasonStartDate,
      lastDay: s.regularSeasonEndDate,
      allStarDate: s.allStarDate || null,
      regularWeeks: SEASON_STRUCTURE.regularWeeks,
      playoffWeeks: SEASON_STRUCTURE.playoffWeeks,
    });
    $("#ad-weeks").value = JSON.stringify(built.weeks, null, 1);
    notes.innerHTML = built.notes.map(escapeHtml).join("<br>");
  } catch (e) {
    notes.textContent = "Couldn't reach the MLB API: " + e.message + " — you can paste a weeks JSON by hand.";
  }
}

async function adminSaveWeeks() {
  try {
    const weeks = JSON.parse($("#ad-weeks").value);
    if (!Array.isArray(weeks) || !weeks.length) throw new Error("weeks must be a non-empty array");
    await L().collection("config").doc("settings").set({ weeks, season: LEAGUE.season }, { merge: true });
    toast(`Saved ${weeks.length} weeks.`, "success");
  } catch (e) { toast("Save failed: " + e.message, "error"); }
}

async function adminGenSchedule() {
  if (!confirm("Generate the season schedule? Existing schedule docs are overwritten.")) return;
  try {
    const sched = ScheduleGen.generateMatchups(LEAGUE_TEAMS.map((t) => t.id), `carrollton-${LEAGUE.season}`);
    const batch = App.fs.batch();
    sched.forEach((w) => {
      batch.set(L().collection("schedule").doc(String(w.week)), {
        week: w.week, type: "regular", matchups: w.matchups,
      });
      w.matchups.forEach((mu, i) => {
        batch.set(L().collection("matchups").doc(`${w.week}_${i}`), {
          week: w.week, index: i, home: mu.home, away: mu.away,
          homePts: 0, awayPts: 0, final: false,
        }, { merge: true });
      });
    });
    // Playoff placeholders (bracket fills itself as weeks finalize).
    for (let w = SEASON_STRUCTURE.regularWeeks + 1; w <= SEASON_STRUCTURE.regularWeeks + SEASON_STRUCTURE.playoffWeeks; w++) {
      batch.set(L().collection("schedule").doc(String(w)), { week: w, type: "playoff", matchups: [] }, { merge: true });
    }
    await batch.commit();
    toast("Schedule generated.", "success");
  } catch (e) { toast("Generate failed: " + e.message, "error"); }
}

async function adminSetFaab() {
  const teamId = $("#ad-faab-team").value;
  const amt = parseInt($("#ad-faab-amt").value, 10);
  if (!Number.isInteger(amt) || amt < 0) return toast("Enter a valid amount.", "error");
  try {
    await L().collection("teams").doc(teamId).set({ faabRemaining: amt }, { merge: true });
    toast(`${teamName(teamId)} FAAB set to $${amt}.`, "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}

async function adminTrade(id, action) {
  const t = App.trades.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`${action === "executed" ? "Execute" : "Veto"} this trade now?`)) return;
  try {
    if (action === "executed") {
      // Swap rosters client-side with commissioner rights (mirrors lib/trades.mjs).
      const [from, to] = await Promise.all([loadRoster(t.from, true), loadRoster(t.to, true)]);
      const batch = App.fs.batch();
      const now = new Date().toISOString();
      (t.gives || []).map(String).forEach((pid) => {
        const p = from.players[pid]; if (!p) throw new Error(`${pid} missing from ${t.from}`);
        delete from.players[pid]; to.players[pid] = { ...p, via: "trade" };
        batch.set(L().collection("players").doc(pid), { rosteredBy: t.to }, { merge: true });
      });
      (t.gets || []).map(String).forEach((pid) => {
        const p = to.players[pid]; if (!p) throw new Error(`${pid} missing from ${t.to}`);
        delete to.players[pid]; from.players[pid] = { ...p, via: "trade" };
        batch.set(L().collection("players").doc(pid), { rosteredBy: t.from }, { merge: true });
      });
      batch.set(L().collection("rosters").doc(t.from), { players: from.players, updatedAt: now }, { merge: true });
      batch.set(L().collection("rosters").doc(t.to), { players: to.players, updatedAt: now }, { merge: true });
      batch.set(L().collection("trades").doc(id), { status: "executed", resolvedAt: now, resolvedNote: "Commissioner override." }, { merge: true });
      await batch.commit();
    } else {
      await L().collection("trades").doc(id).set({
        status: "vetoed", resolvedAt: new Date().toISOString(), resolvedNote: "Commissioner veto.",
      }, { merge: true });
    }
    toast(`Trade ${action}.`, "success");
  } catch (e) { toast("Failed: " + e.message, "error"); }
}
