#!/usr/bin/env node
/*
 * Import the league's real week-by-week history (scripts/data/yahoo-results-2026.json)
 * so the test season mirrors Yahoo exactly: past matchups with final scores,
 * true records/seeds, points for/against, and a week map where live scoring
 * simply continues from the current week.
 *
 *   node scripts/import_results.mjs                    # validate + preview
 *   node scripts/import_results.mjs --write            # write to Firestore
 *
 * Run AFTER import_league.mjs. Re-run any time the JSON gains more weeks
 * (e.g. when weeks 14-15 screenshots arrive, or future matchups are added
 * under "upcoming"). --write needs FIREBASE_SERVICE_ACCOUNT_B64.
 */
import { readFileSync } from "node:fs";
import cfg from "../shared/league-config.js";
import * as MLB from "../netlify/functions/lib/mlb.mjs";

const { LEAGUE_TEAMS, SEASON_STRUCTURE, FAAB } = cfg;
const DATA = JSON.parse(readFileSync("scripts/data/yahoo-results-2026.json", "utf8"));
const SEASON = 2026;
const write = process.argv.includes("--write");

const teamIds = new Set(LEAGUE_TEAMS.map((t) => t.id));
const nameOf = Object.fromEntries(LEAGUE_TEAMS.map((t) => [t.id, t.name]));
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = new Date().toISOString().slice(0, 10);

// ---- validate the data --------------------------------------------------------
const playedWeeks = Object.keys(DATA.weeks).map(Number).sort((a, b) => a - b);
const tally = {};
LEAGUE_TEAMS.forEach((t) => { tally[t.id] = { w: 0, l: 0, t: 0, pf: 0, pa: 0 }; });
playedWeeks.forEach((n) => {
  const mus = DATA.weeks[n];
  if (mus.length !== 6) throw new Error(`week ${n}: expected 6 matchups, got ${mus.length}`);
  const seen = new Set();
  mus.forEach(([home, hp, away, ap]) => {
    if (!teamIds.has(home) || !teamIds.has(away)) throw new Error(`week ${n}: unknown team ${home}/${away}`);
    if (seen.has(home) || seen.has(away)) throw new Error(`week ${n}: team plays twice`);
    seen.add(home); seen.add(away);
    tally[home].pf += hp; tally[home].pa += ap;
    tally[away].pf += ap; tally[away].pa += hp;
    if (hp === ap) { tally[home].t++; tally[away].t++; }
    else if (hp > ap) { tally[home].w++; tally[away].l++; }
    else { tally[away].w++; tally[home].l++; }
  });
});

console.log(`Transcribed weeks: ${playedWeeks.join(", ")}`);
console.log(`\n${"team".padEnd(16)} transcribed   yahoo    PF check`);
let anyGap = false;
DATA.standings.forEach((s) => {
  const t = tally[s.id];
  const gapW = s.w - t.w, gapL = s.l - t.l;
  if (gapW < 0 || gapL < 0) throw new Error(`${s.id}: transcription shows MORE games than Yahoo record — check scores`);
  if (gapW + gapL > 0) anyGap = true;
  // Yahoo's official Pts column verifies the transcription to the point.
  const pfNote = s.pts == null ? "" :
    t.pf === s.pts ? `PF ${t.pf} ✓ matches Yahoo` : `PF ${t.pf} ≠ Yahoo ${s.pts} — CHECK SCORES`;
  console.log(`${s.id.padEnd(16)} ${`${t.w}-${t.l}${t.t ? "-" + t.t : ""}`.padEnd(12)}${`${s.w}-${s.l}${s.t ? "-" + s.t : ""}`.padEnd(8)} ${gapW + gapL ? `${gapW}W ${gapL}L unaccounted · ` : ""}${pfNote}`);
});
if (anyGap) console.log("\n⚠ Some games aren't in the transcript — records import from Yahoo's totals anyway.");

// ---- build the week map ---------------------------------------------------------
// Total/regular week counts come from Yahoo (23 regular + weeks 24-26 playoffs).
const totalWeeks = DATA.totalWeeks || 26;
const regularWeeks = DATA.regularSeasonWeeks || SEASON_STRUCTURE.regularWeeks;
const weeks = [{ n: 1, start: DATA.week1Start, end: DATA.week1End, type: "regular" }];
let cursor = addDays(DATA.week1End, 1);
while (weeks.length < totalWeeks) {
  const n = weeks.length + 1;
  weeks.push({ n, start: cursor, end: addDays(cursor, 6), type: n <= regularWeeks ? "regular" : "playoff" });
  cursor = addDays(cursor, 7);
}
try {
  const seasonEnd = (await MLB.seasonInfo(SEASON))?.regularSeasonEndDate;
  if (seasonEnd && weeks[weeks.length - 1].end > seasonEnd)
    console.log(`⚠ Week ${totalWeeks} ends ${weeks[weeks.length - 1].end}, after MLB's season end ${seasonEnd}.`);
} catch (e) { /* offline — skip the calendar cross-check */ }

const current = weeks.find((w) => w.start <= today && today <= w.end);
const finishedByCalendar = weeks.filter((w) => w.end < today).length;
const finishedByRecords = DATA.standings.reduce((s, t) => s + t.w + t.l + t.t, 0) / LEAGUE_TEAMS.length;
console.log(`\nWeek map: ${weeks.length} weeks (${weeks[0].start} → ${weeks[weeks.length - 1].end}), current week = ${current ? current.n : "none"}`);
if (finishedByCalendar !== finishedByRecords)
  console.log(`⚠ Calendar says ${finishedByCalendar} weeks finished but Yahoo records say ${finishedByRecords} — adjust week1Start/week1End in the JSON.`);
else
  console.log(`✓ Calendar agrees with Yahoo: ${finishedByRecords} weeks finished; live scoring picks up in week ${current ? current.n : "?"}.`);

if (!write) {
  console.log("\nPreview only — add --write (plus FIREBASE_SERVICE_ACCOUNT_B64) to push to Firestore.");
  process.exit(0);
}

// ---- write ------------------------------------------------------------------------
const { leagueRef, db } = await import("../netlify/functions/lib/firebase.mjs");
const L = leagueRef();
const batch = db().batch();
const now = new Date().toISOString();

batch.set(L.collection("config").doc("settings"), {
  season: SEASON, weeks,
  faabBudget: FAAB.budget, keeperMax: cfg.KEEPER.max,
  tradeReviewHours: cfg.TRADE.reviewHours, vetoesNeeded: cfg.TRADE.vetoesNeeded,
}, { merge: true });

// Past weeks: schedule + final matchup scores.
playedWeeks.forEach((n) => {
  const mus = DATA.weeks[n].map(([home, , away]) => ({ home, away }));
  batch.set(L.collection("schedule").doc(String(n)), { week: n, type: "regular", matchups: mus });
  DATA.weeks[n].forEach(([home, hp, away, ap], i) => {
    batch.set(L.collection("matchups").doc(`${n}_${i}`), {
      week: n, index: i, home, away,
      homePts: hp, awayPts: ap, final: true,
      winner: hp === ap ? null : hp > ap ? home : away,
      source: "yahoo-import", updatedAt: now,
    });
  });
});

// Known future/current matchups (from "upcoming" in the JSON).
Object.entries(DATA.upcoming || {}).forEach(([n, mus]) => {
  if (!Array.isArray(mus)) return; // skip the comment field
  const wk = +n;
  batch.set(L.collection("schedule").doc(String(wk)), {
    week: wk, type: (weeks.find((w) => w.n === wk) || {}).type || "regular",
    matchups: mus.map(([home, away]) => ({ home, away })),
  });
  mus.forEach(([home, away], i) => {
    batch.set(L.collection("matchups").doc(`${wk}_${i}`), {
      week: wk, index: i, home, away, homePts: 0, awayPts: 0, final: false,
    }, { merge: true });
  });
});

// Teams: Yahoo's records/ranks/Pts are authoritative; PA from the transcript;
// remaining FAAB comes from Yahoo's Waiver Budget column.
DATA.standings.forEach((s) => {
  batch.set(L.collection("teams").doc(s.id), {
    record: { w: s.w, l: s.l, t: s.t, pf: s.pts ?? Math.round(tally[s.id].pf), pa: Math.round(tally[s.id].pa) },
    seed: s.rank,
    ...(s.faab != null ? { faabRemaining: s.faab } : {}),
  }, { merge: true });
});

await batch.commit();
console.log(`\n✓ Wrote ${playedWeeks.length} finished weeks, standings for 12 teams, and a ${weeks.length}-week map.`);
console.log(`  ${nameOf[DATA.standings[0].id]} leads at ${DATA.standings[0].w}-${DATA.standings[0].l}. Live scoring continues in week ${current ? current.n : "?"}.`);
