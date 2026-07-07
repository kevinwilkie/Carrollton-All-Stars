/*
 * Carrollton All-Stars — prior-season draft data (keeper eligibility).
 * ---------------------------------------------------------------------------
 * 2027 is the league's FIRST season, so there is no prior draft: leave
 * PRIOR_SEASON = null and enter keepers manually (the Keepers tab supports it).
 *
 * From 2028 on, regenerate this file after each season:
 *     node scripts/export_prior_season.mjs
 * It emits { season, map: { mlbId: { name, pos, amount, undrafted,
 * keeperLast, keeperPrev, rostered, owner } } } from our own Firestore
 * draft + roster records — same idea as League of Dreams' Sleeper import,
 * but fed by our own league history.
 */
const PRIOR_SEASON = null;
