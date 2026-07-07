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
 * rosters file: paste Yahoo's league Rosters page RAW — team headers like
 * "Acuña Matata (13-2)" (name + record) and all the glued "Player Note"/
 * "IL10"/game-time noise are handled. Yahoo's split Ohtani (Batter)/(Pitcher)
 * entries are detected and position-restricted. A tidy "## Team (W-L)" +
 * plain-names format works too. Check parsing first:
 *
 *   node scripts/import_league.mjs scripts/data/yahoo-rosters-2026.txt --parse-only
 *
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
// Handles both raw Yahoo roster-page pastes and tidy "## Team" files.
const POS_SET = new Set(["C", "1B", "2B", "3B", "SS", "IF", "INF", "OF", "LF", "CF", "RF",
  "UTIL", "Util", "SP", "RP", "P", "DH", "BN", "IL", "NA"]);
const POS_TOKENS = /^(C|1B|2B|3B|SS|IF|OF|LF|CF|RF|UTIL|Util|SP|RP|P|BN|IL|IL10|IL15|IL60|NA|DTD)\b[\s\-–:]*/;
// Yahoo glues status/notes right onto the name: "Cal RaleighPlayer Note",
// "Mike TroutIL10Player Note", "Matt ChapmanIL10Video ForecastPlayer Note".
const GLUED_NOISE = /(?:No new player Notes?|New Player Note|Video Forecast|Player Notes?|IL\d+|DTD|SUSP|NA)+$/;

function matchTeamHeader(line) {
  const explicit = line.startsWith("##");
  const rec = line.match(/\((\d+)-(\d+)(?:-(\d+))?\)/);
  if (!explicit && !rec) return null; // raw Yahoo headers carry the record
  const nameOnly = norm(line.replace(/^#+\s*/, "").replace(/\(.*?\)/, ""));
  if (!nameOnly) return null;
  const team = LEAGUE_TEAMS.find((t) => {
    const tn = norm(t.name);
    return tn === nameOnly || tn.includes(nameOnly) || nameOnly.includes(tn);
  });
  if (!team && explicit) { console.error(`✗ team header didn't match any league team: "${line}"`); process.exit(1); }
  if (!team) return null;
  return { team, record: rec ? { w: +rec[1], l: +rec[2], t: +(rec[3] || 0) } : null };
}

function isNoise(line) {
  if (/^(Pos|Player)$/i.test(line)) return true;                    // Yahoo table headers
  if (POS_SET.has(line.replace(/[\s\t]+$/, ""))) return true;      // bare slot cell ("C", "BN", …)
  if (/^\d{1,2}:\d{2}\s*(am|pm)/i.test(line)) return true;         // game times
  // club + position list line, e.g. "SEA - C" / "STL - 2B,3B,SS" / "LAD - Util"
  const m = line.match(/^[A-Z]{2,3}\s*-\s*(.+)$/);
  if (m && m[1].split(/[,\s]+/).filter(Boolean).every((tok) => POS_SET.has(tok))) return true;
  return false;
}

const teams = [];
let cur = null;
for (const raw of readFileSync(FILE, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) continue;
  const head = matchTeamHeader(line);
  if (head) { cur = { ...head, players: [] }; teams.push(cur); continue; }
  if (!cur || isNoise(line)) continue;

  let name = line.replace(GLUED_NOISE, "");                 // glued Yahoo suffixes
  // Yahoo splits Ohtani into "(Batter)" / "(Pitcher)" entries — remember which.
  let roleHint = null;
  const role = name.match(/\((Batter|Pitcher)\)\s*$/i);
  if (role) { roleHint = role[1].toLowerCase(); name = name.replace(/\(.*?\)\s*$/, ""); }
  name = name.replace(POS_TOKENS, "").replace(/\s+-\s+.*$/, "")
    .replace(/\s+(Player Notes?|Notes?|DTD|IL\d*|NA)\b.*$/i, "")
    .replace(/\s+[A-Z]{2,3}\s*$/, "")       // trailing club like "KC"/"LAD" (old format)
    .trim();
  if (name) cur.players.push({ line, name, roleHint });
}
console.log(`Parsed ${teams.length} teams, ${teams.reduce((s, t) => s + t.players.length, 0)} players from ${FILE}`);
if (!teams.length) process.exit(1);

if (flag("parse-only")) {
  teams.forEach((t) => {
    console.log(`\n## ${t.team.name}${t.record ? ` (${t.record.w}-${t.record.l}${t.record.t ? "-" + t.record.t : ""})` : ""} — ${t.players.length} players`);
    t.players.forEach((p) => console.log(`  ${p.name}${p.roleHint ? ` [${p.roleHint}]` : ""}`));
  });
  process.exit(0);
}

// ---- 2. resolve names against the full MLB player list ----------------------------
console.log(`Fetching the ${SEASON} MLB player universe…`);
const universe = await MLB.fetchJson(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${SEASON}`);
const byName = {};
(universe.people || []).forEach((p) => {
  (byName[norm(p.fullName)] = byName[norm(p.fullName)] || []).push(p);
});
const clubs = await MLB.allTeams(SEASON);
const abbrOf = Object.fromEntries(clubs.map((c) => [c.id, c.abbreviation]));

const pick = (pl, index) => {
  const cands = index[norm(pl.name)] || [];
  if (!cands.length) return false;
  pl.mlb = cands.length === 1 ? cands[0] : (cands.find((c) => c.active) || cands[0]);
  if (cands.length > 1)
    console.warn(`  ⚠ "${pl.name}" matched ${cands.length} players — using ${pl.mlb.fullName} (${pl.mlb.currentTeam?.id || "?"}). Edit the line if wrong.`);
  return true;
};

let unresolved = [];
teams.forEach((t) => t.players.forEach((pl) => {
  if (!pick(pl, byName)) unresolved.push({ team: t.team.name, pl });
}));

// Long-term IL players who haven't appeared this season are missing from the
// current player list — retry against last season's before giving up.
if (unresolved.length) {
  console.log(`Retrying ${unresolved.length} unresolved against the ${SEASON - 1} player list (long-term IL)…`);
  const prev = await MLB.fetchJson(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${SEASON - 1}`);
  const prevByName = {};
  (prev.people || []).forEach((p) => {
    (prevByName[norm(p.fullName)] = prevByName[norm(p.fullName)] || []).push(p);
  });
  unresolved = unresolved.filter(({ pl }) => !pick(pl, prevByName));
}
unresolved = unresolved.map(({ team, pl }) => ({ team, line: pl.line, name: pl.name }));

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
  // Yahoo-style split entries become separate fantasy players ("{id}:B" /
  // "{id}:P"): the Batter half keeps hitter positions and scores only batting,
  // the Pitcher half keeps SP/RP and scores only pitching.
  if (pl.roleHint === "batter") {
    pl.positions = pl.positions.filter((p) => !["SP", "RP"].includes(p));
    if (!pl.positions.length) pl.positions = ["DH"];
    pl.docId = `${pl.mlb.id}:B`;
    pl.displayName = `${pl.mlb.fullName} (Batter)`;
  } else if (pl.roleHint === "pitcher") {
    pl.positions = pl.positions.filter((p) => ["SP", "RP"].includes(p));
    if (!pl.positions.length) pl.positions = ["SP"];
    pl.docId = `${pl.mlb.id}:P`;
    pl.displayName = `${pl.mlb.fullName} (Pitcher)`;
  } else {
    pl.docId = String(pl.mlb.id);
    pl.displayName = pl.mlb.fullName;
  }
  pl.slots = eligibleSlots(pl.positions);
});

// The same fantasy player (same half, for splits) on two rosters is a real
// conflict — flag it.
const seenOn = {};
teams.forEach((t) => t.players.filter((p) => p.mlb).forEach((pl) => {
  (seenOn[pl.docId] = seenOn[pl.docId] || []).push(t.team.name);
}));
Object.entries(seenOn).filter(([, on]) => on.length > 1).forEach(([id, on]) => {
  const nm = resolved.find((p) => p.docId === id)?.displayName;
  console.warn(`⚠ ${nm} appears on ${on.join(" AND ")} — the last team written wins; fix the paste.`);
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
    players[pl.docId] = {
      mlbId: pl.docId, name: pl.displayName,
      mlbTeam: abbrOf[pl.mlb.currentTeam?.id] || "",
      positions: pl.positions, via: "import", price: 0,
    };
    batch.set(L.collection("players").doc(pl.docId), {
      name: pl.displayName,
      personId: pl.mlb.id,
      ...(pl.roleHint ? { twoWayRole: pl.roleHint === "pitcher" ? "P" : "B" } : {}),
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
