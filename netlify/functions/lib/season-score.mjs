/*
 * Season-aggregate fantasy scoring — turns a whole-season MLB stat line into
 * fantasy points under the league's scoring. Shared by the career endpoint
 * (career.mjs) and the nightly player sync (players-sync.mjs) so there is one
 * definition of a "season to date" total.
 *
 * Hitters are exact: scoreHitting is linear in the counting stats, so the
 * season aggregate scores identically to summing every game. Pitchers reuse the
 * engine for everything EXCEPT quality starts — QS can't be derived from a
 * season aggregate (it's a per-game condition), so we disable the engine's
 * per-game QS (gamesStarted: 0) and add QS × weight from the season's
 * `qualityStarts` count when the API provides it.
 */
import Scoring from "../../../shared/scoring.js";
import { CFG } from "./league.mjs";

const num = (v) => (Number.isFinite(+v) ? +v : 0);

// outs from a season line: prefer the numeric `outs`, else parse "180.1" IP.
export function outsOf(stat) {
  if (!stat) return 0;
  if (Number.isFinite(+stat.outs)) return +stat.outs;
  const s = String(stat.inningsPitched == null ? "" : stat.inningsPitched).split(".");
  return num(s[0]) * 3 + num(s[1]);
}

export function seasonFantasyPoints(stat, pitching) {
  if (!stat) return 0;
  if (!pitching) return Scoring.round1(Scoring.scoreHitting(stat));
  const qsWeight = (CFG.SCORING && CFG.SCORING.pitching && CFG.SCORING.pitching.QS) || 5;
  const base = Scoring.scorePitching({ ...stat, gamesStarted: 0 });
  return Scoring.round1(base + num(stat.qualityStarts) * qsWeight);
}
