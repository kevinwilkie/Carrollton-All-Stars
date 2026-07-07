/*
 * Position eligibility (Yahoo style), from league-config ELIGIBILITY:
 *   - a fielding position with 10+ appearances LAST season or 5+ THIS season
 *   - SP with 3+ starts either season (or any start when totals are tiny)
 *   - RP with 5+ relief appearances either season
 *   - eligibility earned from LAST season holds all year (union — never lost
 *     mid-season); next season recomputes from this season's games alone
 *   - fallbacks: the player's MLB-listed primary position; pure DHs get DH.
 * OF is collapsed (LF/CF/RF all count as OF). Everything else keys the roster
 * slots via SLOT_ELIGIBILITY in shared/league-config.js.
 */
import { CFG } from "./league.mjs";

const OF = new Set(["LF", "CF", "RF", "OF"]);
const FIELD = ["C", "1B", "2B", "3B", "SS", "OF"];

// appearances: { "C": n, "1B": n, ..., "LF": n } (raw position keys ok)
export function normalizeAppearances(appearances) {
  const out = {};
  Object.entries(appearances || {}).forEach(([pos, n]) => {
    const key = OF.has(pos) ? "OF" : pos;
    if (FIELD.includes(key)) out[key] = (out[key] || 0) + (n || 0);
  });
  return out;
}

/*
 * player: {
 *   primary: "SS"|"P"|"TWP"|…            (MLB-listed primary position)
 *   apprLastSeason: {pos: games}, apprThisSeason: {pos: games}
 *   gsLastSeason, gsThisSeason           (pitching starts)
 *   reliefLastSeason, reliefThisSeason   (relief appearances)
 *   pitchedLastSeason, pitchedThisSeason (total pitching games)
 * }
 * → positions array like ["2B","SS"] / ["SP"] / ["DH","SP"] (two-way)
 */
export function computePositions(player) {
  const E = CFG.ELIGIBILITY;
  const last = normalizeAppearances(player.apprLastSeason);
  const cur = normalizeAppearances(player.apprThisSeason);
  const positions = [];

  FIELD.forEach((pos) => {
    if ((last[pos] || 0) >= E.lastSeasonGames || (cur[pos] || 0) >= E.thisSeasonGames)
      positions.push(pos);
  });

  // Pitching roles
  const gs = (player.gsLastSeason || 0) + (player.gsThisSeason || 0);
  const relief = (player.reliefLastSeason || 0) + (player.reliefThisSeason || 0);
  const pitched = (player.pitchedLastSeason || 0) + (player.pitchedThisSeason || 0);
  const isPitcherPrimary = ["P", "SP", "RP", "TWP"].includes(player.primary);
  if (gs >= E.spStarts || (gs > 0 && pitched > 0 && pitched < 8)) positions.push("SP");
  if (relief >= E.rpRelief) positions.push("RP");
  if (isPitcherPrimary && !positions.includes("SP") && !positions.includes("RP")) {
    // No thresholds met (season start / new arm): trust the listed role.
    positions.push(gs > 0 || player.primary === "SP" ? "SP" : "RP");
  }

  // Hitters with no qualifying field position bat as DH (fills UTIL/BN).
  const hasHitterPos = positions.some((p) => FIELD.includes(p));
  const hits = Object.keys(last).length + Object.keys(cur).length > 0;
  if (!hasHitterPos && (player.primary === "DH" || player.primary === "TWP" || (!isPitcherPrimary && !hasHitterPos))) {
    positions.unshift("DH");
  } else if (player.primary === "TWP" && !positions.includes("DH") && hits) {
    positions.unshift("DH");
  }

  // Order: primary MLB position first when present, rest stable.
  const primaryKey = OF.has(player.primary) ? "OF" : player.primary;
  positions.sort((a, b) => (a === primaryKey ? -1 : b === primaryKey ? 1 : 0));
  return [...new Set(positions)];
}

// Which lineup slot types a positions-array can fill (stored on the player doc
// so the season app filters free agents by slot without recomputing).
export function eligibleSlots(positions) {
  const out = [];
  Object.entries(CFG.SLOT_ELIGIBILITY).forEach(([slot, ok]) => {
    if (slot === "BN" || slot === "IL") return;
    if ((positions || []).some((p) => ok.includes(p))) out.push(slot);
  });
  return out;
}
