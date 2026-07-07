/*
 * Carrollton All-Stars — roster slot feasibility (draft board)
 * ---------------------------------------------------------------------------
 * Baseball rosters can't use flat position caps (League of Dreams' QB≤4 trick)
 * because players are multi-position and INF/UTIL/BN slots overlap. Instead:
 * "may this manager draft this player?" = "is there a perfect assignment of
 * all their players (plus the candidate) onto the 26 slots?" — a bipartite
 * maximum matching, solved with Kuhn's augmenting paths. At ≤27 players × 26
 * slots this is instant.
 *
 * Uses LINEUP_SLOTS, BENCH_SLOTS, SLOT_ELIGIBILITY, ROSTER_SIZE — page globals
 * in the browser, required from shared/league-config.js under Node (the
 * Netlify functions reuse this matcher to build initial daily lineups).
 */
const Feasibility = (function () {
  "use strict";

  const cfg = (typeof LINEUP_SLOTS !== "undefined")
    ? { LINEUP_SLOTS, BENCH_SLOTS, SLOT_ELIGIBILITY, ROSTER_SIZE }
    : require("../shared/league-config.js");
  const { LINEUP_SLOTS: L_SLOTS, BENCH_SLOTS: B_SLOTS,
          SLOT_ELIGIBILITY: SLOT_OK, ROSTER_SIZE: R_SIZE } = cfg;

  // The 26 draftable slots, in display order (starters, then bench).
  function draftSlots() {
    return L_SLOTS.concat(Array(B_SLOTS).fill("BN"));
  }

  function playerFitsSlot(positions, slot) {
    const ok = SLOT_OK[slot];
    return !!ok && (positions || []).some((p) => ok.includes(p));
  }

  // Try flexible slots last so stars land in their real positions on display:
  // exact position → INF → UTIL → BN.
  const SLOT_FLEX = { INF: 1, UTIL: 2, BN: 3 };

  // players: array of positions-arrays, e.g. [["2B","SS"],["SP"],…]
  // Returns { slots, playerSlot[], matched, complete }.
  function match(players) {
    const slots = draftSlots();
    const adj = players.map((positions) => {
      const list = [];
      slots.forEach((s, i) => { if (playerFitsSlot(positions, s)) list.push(i); });
      list.sort((a, b) => (SLOT_FLEX[slots[a]] || 0) - (SLOT_FLEX[slots[b]] || 0) || a - b);
      return list;
    });
    const slotOwner = new Array(slots.length).fill(-1);
    const playerSlot = new Array(players.length).fill(-1);

    function augment(p, seen) {
      for (const s of adj[p]) {
        if (seen[s]) continue;
        seen[s] = true;
        if (slotOwner[s] === -1 || augment(slotOwner[s], seen)) {
          slotOwner[s] = p;
          playerSlot[p] = s;
          return true;
        }
      }
      return false;
    }

    let matched = 0;
    for (let p = 0; p < players.length; p++) {
      if (augment(p, new Array(slots.length).fill(false))) matched++;
    }
    return { slots, playerSlot, matched, complete: matched === players.length };
  }

  // Can this candidate join the given roster and still leave a legal lineup?
  function canFit(rosterPositions, candidatePositions) {
    if (rosterPositions.length >= R_SIZE) return false;
    return match(rosterPositions.concat([candidatePositions])).complete;
  }

  // Lay picks out on the 26 slots for the Rosters grid / roster modal.
  // picks: [{positions, …}] → { cells: [{slot, player|null}], overflow: [...] }
  function assignSlots(picks) {
    const m = match(picks.map((p) => p.positions || []));
    const cells = m.slots.map((slot) => ({ slot, player: null }));
    m.playerSlot.forEach((s, i) => { if (s >= 0) cells[s].player = picks[i]; });
    const overflow = picks.filter((_, i) => m.playerSlot[i] === -1);
    return { cells, overflow };
  }

  // For the Roster Needs tab: which single-position player types can this
  // roster still legally add? Returns { C: true/false, "1B": …, SP: …, RP: … }.
  function openPositions(rosterPositions) {
    const out = {};
    ["C", "1B", "2B", "3B", "SS", "OF", "DH", "SP", "RP"].forEach((pos) => {
      out[pos] = canFit(rosterPositions, [pos]);
    });
    return out;
  }

  return { draftSlots, playerFitsSlot, match, canFit, assignSlots, openPositions };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Feasibility;
