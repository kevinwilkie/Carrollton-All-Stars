/*
 * Daily lineup rollover: each morning every team gets a lineup doc for the
 * new day, copied from its most recent lineup (or auto-built from the roster
 * the first time). Owners then adjust it until each player's game locks.
 */
import Feasibility from "../../../draft/feasibility.js";
import { db, leagueRef } from "./firebase.mjs";
import { CFG, addDays } from "./league.mjs";
import { slotKeys, slotType } from "./ingest.mjs";

// Build a fresh slots map from a roster: matcher assigns starters, leftovers
// go to bench; players on an MLB IL prefer IL slots only if starters overflow.
export function buildLineup(rosterPlayers) {
  const keys = slotKeys();
  const slots = Object.fromEntries(keys.map((k) => [k, null]));
  const { cells, overflow } = Feasibility.assignSlots(rosterPlayers);
  // cells align to the 26 draftable slots in order; map to unique keys.
  const draftKeys = keys.filter((k) => slotType(k) !== "IL");
  cells.forEach((c, i) => { if (c.player) slots[draftKeys[i]] = c.player.mlbId || null; });
  // Anything unplaced lands on open IL keys (roster > 26 means IL stashes).
  const ilKeys = keys.filter((k) => slotType(k) === "IL");
  overflow.forEach((p, i) => { if (ilKeys[i]) slots[ilKeys[i]] = p.mlbId || null; });
  return slots;
}

export async function ensureLineups(date) {
  const L = leagueRef();
  const batch = db().batch();
  let created = 0;

  for (const t of CFG.LEAGUE_TEAMS) {
    const ref = L.collection("lineups").doc(`${t.id}_${date}`);
    if ((await ref.get()).exists) continue;

    // Copy the most recent lineup within the last 10 days.
    let slots = null;
    for (let back = 1; back <= 10 && !slots; back++) {
      const prev = await L.collection("lineups").doc(`${t.id}_${addDays(date, -back)}`).get();
      if (prev.exists) slots = prev.data().slots || null;
    }
    if (!slots) {
      // First lineup ever: auto-build from the published roster.
      const roster = (await L.collection("rosters").doc(t.id).get()).data() || {};
      const players = Object.entries(roster.players || {}).map(([key, p]) => ({
        mlbId: p.mlbId || key, positions: p.positions || [],
      }));
      slots = buildLineup(players);
    }
    batch.set(ref, { teamId: t.id, date, slots, locked: {}, createdAt: new Date().toISOString() });
    created++;
  }
  if (created) await batch.commit();
  return created;
}
