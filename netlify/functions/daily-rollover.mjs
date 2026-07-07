/*
 * daily-rollover — 08:10 UTC daily (3:10am EST / 4:10am EDT), before any game:
 *   1. final stats pass for yesterday
 *   2. finalize the scoring week if it just ended (records, seeds, bracket)
 *   3. process FAAB waiver claims (highest bid, ties → worse record)
 *   4. sync the player universe (clubs, IL, appearance counters, eligibility)
 *   5. write today's game/lock times + roll every team's lineup forward
 */
import { ingestDate, ensureMlbDay } from "./lib/ingest.mjs";
import { finalizeWeekIfEnded } from "./lib/standings.mjs";
import { processClaims, expireStaleClaims } from "./lib/waivers.mjs";
import { syncPlayers } from "./lib/players-sync.mjs";
import { ensureLineups } from "./lib/lineups.mjs";
import { etDate, addDays, CFG } from "./lib/league.mjs";
import { leagueRef } from "./lib/firebase.mjs";

export default async () => {
  const today = etDate();
  const yesterday = addDays(today, -1);
  const out = { today };

  // The active season comes from Firestore config (falls back to the code
  // default) so a test season can run against the current MLB year.
  let season = CFG.LEAGUE.season;
  try {
    const s = (await leagueRef().collection("config").doc("settings").get()).data();
    if (s && s.season) season = s.season;
  } catch (e) { /* keep default */ }

  const step = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (e) { console.error(`${name} failed:`, e); out[name] = { error: String(e && e.message || e) }; }
  };

  await step("finalIngest", () => ingestDate(yesterday));
  await step("weekFinalized", () => finalizeWeekIfEnded(yesterday));
  await step("waivers", () => processClaims(today));
  await step("expiredClaims", () => expireStaleClaims(today));
  await step("playersSynced", () => syncPlayers(yesterday, season));
  await step("todaysGames", async () => (await ensureMlbDay(today, { refresh: true })).length);
  await step("lineupsCreated", () => ensureLineups(today));

  console.log("daily-rollover:", JSON.stringify(out));
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};
