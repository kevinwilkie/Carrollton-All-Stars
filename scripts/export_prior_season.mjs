#!/usr/bin/env node
/*
 * Export last season's league history → draft/data/prior-season.js, feeding
 * the draft board's keeper-eligibility card (who's Year 1 / Year 2 / done).
 * Run each offseason from 2028 on (2027 is the first season — nothing to export).
 * Needs FIREBASE_SERVICE_ACCOUNT_B64 (same env var as the functions).
 *
 *   FIREBASE_SERVICE_ACCOUNT_B64=... node scripts/export_prior_season.mjs --season 2027
 */
import { writeFileSync } from "node:fs";
import { leagueRef } from "../netlify/functions/lib/firebase.mjs";
import cfg from "../shared/league-config.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SEASON = +arg("season", cfg.LEAGUE.season - 1);
const OUT = arg("out", "draft/data/prior-season.js");

const L = leagueRef();
const draftDoc = await L.collection("drafts").doc(String(SEASON)).get();
if (!draftDoc.exists) { console.error(`No draft archive for ${SEASON}.`); process.exit(1); }
const picks = draftDoc.data().picks || [];

const teams = {};
(await L.collection("teams").get()).forEach((d) => { teams[d.id] = d.data(); });

// End-of-season rosters decide who is still keepable + who owns them.
const rosteredBy = {};
for (const t of cfg.LEAGUE_TEAMS) {
  const r = (await L.collection("rosters").doc(t.id).get()).data() || {};
  Object.values(r.players || {}).forEach((p) => { rosteredBy[String(p.mlbId)] = { teamId: t.id, entry: p }; });
}

const map = {};
picks.forEach((p) => {
  const id = String(p.id || p.key);
  const owner = rosteredBy[id];
  map[id] = {
    name: p.name,
    pos: p.pos || (p.positions || [])[0] || "",
    amount: p.bid,
    keeperLast: !!p.keeper,               // was a keeper IN this draft
    keeperPrev: p.keeper ? p.keeperYear === 2 : false,
    undrafted: false,
    rostered: !!owner,
    owner: owner ? (teams[owner.teamId] || {}).name || owner.teamId : "",
  };
});
// Season pickups (FAAB/trades) that weren't in the draft → Year 1 at flat $5.
Object.entries(rosteredBy).forEach(([id, { teamId, entry }]) => {
  if (map[id]) return;
  map[id] = {
    name: entry.name, pos: (entry.positions || [])[0] || "",
    amount: 0, undrafted: true, keeperLast: false, keeperPrev: false,
    rostered: true, owner: (teams[teamId] || {}).name || teamId,
  };
});

const body = `/*
 * Carrollton All-Stars — prior-season data (GENERATED — do not hand-edit).
 * Season ${SEASON}: ${picks.length} draft picks + season pickups.
 * Regenerate: node scripts/export_prior_season.mjs --season ${SEASON}
 */
const PRIOR_SEASON = ${JSON.stringify({ season: SEASON, map }, null, 1)};
`;
writeFileSync(OUT, body);
console.log(`Wrote ${Object.keys(map).length} players → ${OUT}`);
