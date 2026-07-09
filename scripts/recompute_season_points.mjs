#!/usr/bin/env node
/*
 * Recompute every player's season-to-date fantasy points from the complete MLB
 * season stats — run locally to fix totals now without waiting on (or timing
 * out) the nightly daily-rollover. Idempotent; safe to re-run.
 *
 *   node scripts/recompute_season_points.mjs             # season from config
 *   node scripts/recompute_season_points.mjs --season 2026
 *
 * Needs FIREBASE_SERVICE_ACCOUNT_B64 (same as the functions).
 */
import { recomputeSeasonPoints } from "../netlify/functions/lib/players-sync.mjs";
import { leagueRef } from "../netlify/functions/lib/firebase.mjs";
import { CFG } from "../netlify/functions/lib/league.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

let season = +arg("season", 0);
if (!season) {
  season = CFG.LEAGUE.season;
  try {
    const s = (await leagueRef().collection("config").doc("settings").get()).data();
    if (s && s.season) season = s.season;
  } catch (e) { /* keep default */ }
}

console.log(`Recomputing season points for season ${season}…`);
const n = await recomputeSeasonPoints(season);
console.log(`✓ updated ${n} players`);