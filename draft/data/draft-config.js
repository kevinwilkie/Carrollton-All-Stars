/*
 * Carrollton All-Stars — draft-board specific configuration.
 * League-wide rules (budget, roster, keepers, owners) live in
 * shared/league-config.js — edit THAT for rule changes.
 */

// Where this draft syncs in the Realtime Database. Bump each season so old
// drafts stay archived (draft/2027, draft/2028, …).
const SYNC_PATH = "draft/2027";

// Order position groups render on the board + Undrafted tab.
// (Grouping uses each player's primary position; multi-position eligibility
// still shows as extra badges and counts for roster slots.)
const POSITION_ORDER = ["C", "1B", "2B", "3B", "SS", "DH", "OF", "SP", "RP"];

// ESPN fantasy baseball live draft trends (Year-2 keeper prices).
const ESPN_SEASON = 2027;
const ESPN_KEEPER_DEADLINE = (typeof KEEPER !== "undefined" && KEEPER.espnDeadline) || "2027-03-14";
