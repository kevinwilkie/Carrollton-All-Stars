#!/usr/bin/env node
/*
 * Import your current league (e.g. from Yahoo) so the platform can be tested
 * with real rosters against the LIVE current MLB season.
 *
 *   node scripts/import_league.mjs rosters.txt --season 2026            # dry run: parse + resolve, print
 *   node scripts/import_league.mjs rosters.txt --season 2026 --write    # seed Firestore (needs env vars)
 *   node scripts/import_league.mjs rosters.txt --season 2026 --write --test
 *       --test also configures scoring weeks for the REMAINDER of that season
 *       (starting next Monday, last ≤3 weeks = playoffs) and generates the
 *       schedule, so the 30-minute ingest starts scoring real games.
 *
 * rosters.txt format — copy/paste from Yahoo and lightly tidy:
 *
 *   ## Acuña Matata (12-8-1)
 *   José Ramírez
 *   Aaron Judge
 *   ...
 *   ## Rally Cats (10-11)
 *   ...
 *
 * A "## " line starts a team (matched loosely against league-config names;
 * the (W-L) or (W-L-T) record is optional). Player lines can carry Yahoo
 * junk — "C - José Ramírez Cle 3B" works — but one player per line.
 * Unresolved names are listed at the end; fix the line and re-run.
 * --write needs FIREBASE_SERVICE_ACCOUNT_B64 (SETUP.md §6).
 */
import { readFileSync } from "node:fs";
import cfg from "../shared/league-config.js";
import ScheduleGen from "../shared/schedule-gen.js";
import * as MLB from "../netlify/functions/lib/mlb.mjs";
import { computePositions, eligibleSlots } from "../netlify/functions/lib/eligibility.mjs";

const { LEAGUE_TEAMS, SEASON_STRUCTURE, FAAB } = cfg;
const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"));
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i > -1 ? args[i + 1] : d; };
const SEASON = +opt("season", new Date().getFullYear());
if (!FILE) { console.error("usage: import_league.mjs <rosters.txt> [--season 2026] [--write] [--test]"); process.exit(1); }

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[.'’`-]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").trim();

// ---- 1. parse the paste ---------------------------------------------------------
const POS_TOKENS = /^(C|1B|2B|3B|SS|OF|LF|CF|RF|UTIL|Util|SP|RP|P|BN|IL|IL10|IL15|IL60|NA|DTD)\b[\s\-–:]*/;
const teams = [];
let cur = null;
for (const raw of readFileSync(FILE, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith("##")) {
    const head = line.replace(/^#+\s*/, "");
    const rec = head.match(/\((\d+)-(\d+)(?:-(\d+))?\)/);
    const nameOnly = norm(head.replace(/\(.*?\)/, ""));
    const team = LEAGUE_TEAMS.find((t) => {
      const tn = norm(t.name);
      return tn === nameOnly || tn.includes(nameOnly) || nameOnly.includes(tn);
    });
    if (!team) { console.error(`✗ team header didn't match any league team: "${head}"`); process.exit(1); }
    cur = { team, record: rec ? { w: +rec[1], l: +rec[2], t: +(rec[3] || 0) } : null, players: [] };
    teams.push(cur);
    continue;
  }
  if (!cur) continue;
  // strip leading slot tokens, trailing "Cle - 3B"-style club/pos noise
  let name = line.replace(POS_TOKENS, "").replace(/\s+-\s+.*$/, "")
    .replace(/\s+(Player Notes?|Notes?|DTD|IL\d*|NA)\b.*$/i, "")
    .replace(/\s+[A-Z][a-z]{1,2}\s*$/, "")  // trailing club like "Cle" (best effort)
    .replace(/\s+[A-Z]{2,3}\s*$/, "")       // trailing club like "KC"/"LAD"/"NYY"
    .trim();
  if (name) cur.players.push({ line, name });
}
console.log(`Parsed ${teams.length} teams, ${teams.reduce((s, t) => s + t.players.length, 0)} players from ${FILE}`);
if (!teams.length) process.exit(1);

// ---- 2. resolve names against the full MLB player list ----------------------------
console.log(`Fetching the ${SEASON} MLB player universe…`);
const universe = await MLB.fetchJson(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${SEASON}`);
const byName = {};
(universe.people || []).forEach((p) => {
  (byName[norm(p.fullName)] = byName[norm(p.fullName)] || []).push(p);
});
const clubs = await MLB.allTeams(SEASON);
const abbrOf = Object.fromEntries(clubs.map((c) => [c.id, c.abbreviation]));

const unresolved = [];
teams.forEach((t) => t.players.forEach((pl) => {
  const cands = byName[norm(pl.name)] || [];
  if (cands.length === 1) pl.mlb = cands[0];
  else if (cands.length > 1) {
    pl.mlb = cands.find((c) => c.active) || cands[0];
    console.warn(`  ⚠ "${pl.name}" matched ${cands.length} players — using ${pl.mlb.fullName} (${pl.mlb.currentTeam?.id || "?"}). Edit the line if wrong.`);
  } else unresolved.push({ team: t.team.name, line: pl.line, name: pl.name });
}));

teams.forEach((t) => {
  const okCount = t.players.filter((p) => p.mlb).length;
  console.log(`  ${t.team.name}: ${okCount}/${t.players.length} resolved${t.record ? ` · record ${t.record.w}-${t.record.l}-${t.record.t}` : ""}`);
});
if (unresolved.length) {
  console.log(`\n✗ ${unresolved.length} unresolved name(s) — tidy these lines and re-run:`);
  unresolved.forEach((u) => console.log(`  [${u.team}] "${u.line}" → parsed as "${u.name}"`));
}

// ---- 3. eligibility from season splits ---------------------------------------------
const resolved = teams.flatMap((t) => t.players.filter((p) => p.mlb));
console.log(`\nFetching ${SEASON} splits for ${resolved.length} players (eligibility)…`);
const splits = await MLB.seasonStats(resolved.map((p) => p.mlb.id), SEASON);
resolved.forEach((pl) => {
  const s = splits[pl.mlb.id] || { fielding: {}, pitching: null, primary: pl.mlb.primaryPosition?.abbreviation };
  pl.positions = computePositions({
    primary: s.primary || pl.mlb.primaryPosition?.abbreviation || "",
    apprLastSeason: {}, apprThisSeason: s.fielding,
    gsThisSeason: s.pitching?.gamesStarted || 0,
    reliefThisSeason: Math.max(0, (s.pitching?.games || 0) - (s.pitching?.gamesStarted || 0)),
    pitchedThisSeason: s.pitching?.games || 0,
  });
  pl.slots = eligibleSlots(pl.positions);
});

if (!flag("write")) {
  console.log("\nDry run only. Add --write (plus FIREBASE_SERVICE_ACCOUNT_B64) to seed Firestore,");
  console.log("and --test to also configure live scoring weeks for the rest of the season.");
  process.exit(unresolved.length ? 2 : 0);
}

// ---- 4. write to Firestore -----------------------------------------------------------
const { leagueRef, db } = await import("../netlify/functions/lib/firebase.mjs");
const L = leagueRef();
const now = new Date().toISOString();
const batch = db().batch();

teams.forEach((t) => {
  const players = {};
  t.players.filter((p) => p.mlb).forEach((pl) => {
    players[String(pl.mlb.id)] = {
      mlbId: pl.mlb.id, name: pl.mlb.fullName,
      mlbTeam: abbrOf[pl.mlb.currentTeam?.id] || "",
      positions: pl.positions, via: "import", price: 0,
    };
    batch.set(L.collection("players").doc(String(pl.mlb.id)), {
      name: pl.mlb.fullName,
      mlbTeamId: pl.mlb.currentTeam?.id || null,
      mlbTeam: abbrOf[pl.mlb.currentTeam?.id] || "",
      primary: pl.mlb.primaryPosition?.abbreviation || "",
      positions: pl.positions, eligibleSlots: pl.slots,
      rosteredBy: t.team.id, updatedAt: now,
    }, { merge: true });
  });
  batch.set(L.collection("rosters").doc(t.team.id), { players, updatedAt: now });
  batch.set(L.collection("teams").doc(t.team.id), {
    name: t.team.name, owner: t.team.owner, ownerEmails: t.team.emails,
    faabRemaining: FAAB.budget,
    ...(t.record ? { record: { ...t.record, pf: 0, pa: 0 } } : {}),
  }, { merge: true });
});

if (flag("test")) {
  // Scoring weeks for the REST of this season: start next Monday; the final
  // up-to-3 full weeks become the playoffs.
  const info = await MLB.seasonInfo(SEASON);
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const start = addDaysIso(today, (8 - dow) % 7 || 7); // next Monday
  const weeks = [];
  let n = 1;
  for (let cur2 = start; addDaysIso(cur2, 6) <= info.regularSeasonEndDate; cur2 = addDaysIso(cur2, 7)) {
    weeks.push({ n: n++, start: cur2, end: addDaysIso(cur2, 6), type: "regular" });
  }
  const po = Math.min(SEASON_STRUCTURE.playoffWeeks, Math.max(0, weeks.length - 1));
  weeks.slice(-po).forEach((w) => { w.type = "playoff"; });
  const regular = weeks.filter((w) => w.type === "regular").length;
  console.log(`Test season: ${weeks.length} weeks (${regular} regular + ${po} playoff), ${weeks[0]?.start} → ${weeks[weeks.length - 1]?.end}`);

  batch.set(L.collection("config").doc("settings"), {
    season: SEASON, weeks,
    faabBudget: FAAB.budget, keeperMax: cfg.KEEPER.max,
    tradeReviewHours: cfg.TRADE.reviewHours, vetoesNeeded: cfg.TRADE.vetoesNeeded,
  }, { merge: true });

  const sched = ScheduleGen.generateMatchups(LEAGUE_TEAMS.map((t) => t.id), `carrollton-test-${SEASON}`);
  weeks.filter((w) => w.type === "regular").forEach((w, i) => {
    const mus = sched[i % sched.length].matchups;
    batch.set(L.collection("schedule").doc(String(w.n)), { week: w.n, type: "regular", matchups: mus });
    mus.forEach((mu, j) => batch.set(L.collection("matchups").doc(`${w.n}_${j}`),
      { week: w.n, index: j, home: mu.home, away: mu.away, homePts: 0, awayPts: 0, final: false }, { merge: true }));
  });
  weeks.filter((w) => w.type === "playoff").forEach((w) =>
    batch.set(L.collection("schedule").doc(String(w.n)), { week: w.n, type: "playoff", matchups: [] }, { merge: true }));
}

await batch.commit();
console.log(`\n✓ Imported ${teams.length} teams / ${resolved.length} players to Firestore.`);
if (flag("test")) console.log("✓ Live scoring configured — lineups appear after the next daily-rollover (or test-run it in Netlify).");
if (unresolved.length) console.log(`⚠ ${unresolved.length} players were skipped (unresolved) — add them via waivers or re-run.`);

function addDaysIso(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
