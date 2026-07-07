#!/usr/bin/env node
/*
 * Generate + validate the 21-week balanced round robin (and optionally the
 * week map from the MLB calendar). Prints to stdout; --write pushes to
 * Firestore (needs FIREBASE_SERVICE_ACCOUNT_B64, same as the functions).
 *
 *   node scripts/generate_schedule.mjs                # print + validate
 *   node scripts/generate_schedule.mjs --weeks        # also build the week map (needs internet)
 *   node scripts/generate_schedule.mjs --write        # write schedule (+ weeks) to Firestore
 *
 * The Admin tab does the same thing from the browser — this is the offline twin.
 */
import ScheduleGen from "../shared/schedule-gen.js";
import cfg from "../shared/league-config.js";

const { LEAGUE, LEAGUE_TEAMS, SEASON_STRUCTURE } = cfg;
const flags = new Set(process.argv.slice(2));

const teamIds = LEAGUE_TEAMS.map((t) => t.id);
const sched = ScheduleGen.generateMatchups(teamIds, `carrollton-${LEAGUE.season}`);

// ---- validate -----------------------------------------------------------------
const games = {};
const meetings = {};
teamIds.forEach((t) => { games[t] = 0; });
sched.forEach((w) => {
  if (w.matchups.length !== teamIds.length / 2) throw new Error(`week ${w.week}: ${w.matchups.length} matchups`);
  const seen = new Set();
  w.matchups.forEach((m) => {
    if (seen.has(m.home) || seen.has(m.away)) throw new Error(`week ${w.week}: team plays twice`);
    seen.add(m.home); seen.add(m.away);
    games[m.home]++; games[m.away]++;
    const key = [m.home, m.away].sort().join("|");
    meetings[key] = (meetings[key] || 0) + 1;
  });
});
const counts = Object.values(meetings);
console.log(`✓ ${sched.length} weeks, ${sched.length * 6} matchups`);
console.log(`✓ games per team: ${[...new Set(Object.values(games))].join(",")} (expect ${SEASON_STRUCTURE.regularWeeks})`);
console.log(`✓ opponent meetings: ${counts.filter((c) => c === 2).length} pairs twice, ${counts.filter((c) => c === 1).length} pairs once (expect 60 + 6)`);

if (flags.has("--print") || !flags.has("--write")) {
  sched.slice(0, 3).forEach((w) => {
    console.log(`\nWeek ${w.week}:`);
    w.matchups.forEach((m) => console.log(`  ${m.away} @ ${m.home}`));
  });
  console.log(`  … (${sched.length} weeks total; use --write to push to Firestore)`);
}

// ---- week map (optional, needs internet) -----------------------------------------
let weeks = null;
if (flags.has("--weeks") || flags.has("--write")) {
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/seasons/${LEAGUE.season}?sportId=1`);
    const s = ((await res.json()).seasons || [])[0] || {};
    const built = ScheduleGen.buildWeekMap({
      openingDay: s.regularSeasonStartDate,
      lastDay: s.regularSeasonEndDate,
      allStarDate: s.allStarDate || null,
      regularWeeks: SEASON_STRUCTURE.regularWeeks,
      playoffWeeks: SEASON_STRUCTURE.playoffWeeks,
    });
    weeks = built.weeks;
    console.log(`\nWeek map (${weeks.length} weeks): ${weeks[0].start} → ${weeks[weeks.length - 1].end}`);
    built.notes.forEach((n) => console.log("  " + n));
  } catch (e) {
    console.warn(`\n⚠ Couldn't build the week map (offline?): ${e.message}`);
  }
}

// ---- write to Firestore (optional) -------------------------------------------------
if (flags.has("--write")) {
  const { leagueRef, db } = await import("../netlify/functions/lib/firebase.mjs");
  const L = leagueRef();
  const batch = db().batch();
  sched.forEach((w) => {
    batch.set(L.collection("schedule").doc(String(w.week)), { week: w.week, type: "regular", matchups: w.matchups });
    w.matchups.forEach((mu, i) => {
      batch.set(L.collection("matchups").doc(`${w.week}_${i}`),
        { week: w.week, index: i, home: mu.home, away: mu.away, homePts: 0, awayPts: 0, final: false }, { merge: true });
    });
  });
  for (let w = SEASON_STRUCTURE.regularWeeks + 1; w <= SEASON_STRUCTURE.regularWeeks + SEASON_STRUCTURE.playoffWeeks; w++)
    batch.set(L.collection("schedule").doc(String(w)), { week: w, type: "playoff", matchups: [] }, { merge: true });
  if (weeks) batch.set(L.collection("config").doc("settings"), { weeks, season: LEAGUE.season }, { merge: true });
  await batch.commit();
  console.log("\n✓ Written to Firestore.");
}
