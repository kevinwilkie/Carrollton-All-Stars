/*
 * Carrollton All-Stars — Scoring Engine
 * ---------------------------------------------------------------------------
 * Pure functions that turn an MLB Stats API stat line into fantasy points.
 * Used by BOTH the browser apps (<script> global `Scoring`) and the Netlify
 * functions / scripts (`import Scoring from "../shared/scoring.js"`), so the
 * league only ever has one definition of a point.
 *
 * Input shape = the `stats.batting` / `stats.pitching` objects from a game
 * boxscore (statsapi.mlb.com), normalized by lib/mlb.js. All fields optional;
 * missing stats count as 0 so partial lines never throw.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const n = (v) => (Number.isFinite(+v) ? +v : 0);

  // Weights are read from league-config when it's loaded (browser page global
  // or the imported module); these literals are the fallback so the engine
  // also works standalone (tests, replay script without config).
  function weights() {
    const cfg =
      (typeof SCORING !== "undefined" && SCORING) ||
      (() => { try { return require("./league-config.js").SCORING; } catch (e) { return null; } })();
    return cfg || {
      hitting: { "1B": 1, "2B": 2, "3B": 3, HR: 4, BB: 1, IBB: 1, R: 1, RBI: 1, SB: 2, SO: -1 },
      pitching: { OUT: 1, SO: 1, W: 2, QS: 5, SV: 5, HLD: 2, CG: 3, SHO: 3, ER: -2, H: -1, BB: -1 },
      qualityStart: { minOuts: 18, maxEarnedRuns: 3 },
    };
  }

  // ---- Hitting ---------------------------------------------------------------
  // b: { hits, doubles, triples, homeRuns, baseOnBalls, intentionalWalks,
  //      runs, rbi, stolenBases, strikeOuts }
  // Singles are derived: H − 2B − 3B − HR. IBB scores on top of the BB it
  // already is (league rule — see league-config.js).
  function scoreHitting(b) {
    if (!b) return 0;
    const W = weights().hitting;
    const singles = n(b.hits) - n(b.doubles) - n(b.triples) - n(b.homeRuns);
    return (
      singles * W["1B"] +
      n(b.doubles) * W["2B"] +
      n(b.triples) * W["3B"] +
      n(b.homeRuns) * W.HR +
      n(b.baseOnBalls) * W.BB +
      n(b.intentionalWalks) * W.IBB +
      n(b.runs) * W.R +
      n(b.rbi) * W.RBI +
      n(b.stolenBases) * W.SB +
      n(b.strikeOuts) * W.SO
    );
  }

  // ---- Pitching --------------------------------------------------------------
  // p: { outs (or inningsPitched "6.2"), strikeOuts, hits, earnedRuns,
  //      baseOnBalls, wins, saves, holds, completeGames, shutouts,
  //      gamesStarted }
  // QS is derived (6+ IP, ≤3 ER, must have started); W/SV/HLD/CG/SHO come off
  // the box score as 0/1 for that game.
  function outsOf(p) {
    if (Number.isFinite(+p.outs)) return +p.outs;
    // inningsPitched arrives as a string like "6.2" = 6 innings + 2 outs
    const ip = String(p.inningsPitched || "0.0").split(".");
    return n(ip[0]) * 3 + n(ip[1]);
  }

  function isQualityStart(p) {
    if (!p || !n(p.gamesStarted)) return false;
    const q = weights().qualityStart;
    return outsOf(p) >= q.minOuts && n(p.earnedRuns) <= q.maxEarnedRuns;
  }

  function scorePitching(p) {
    if (!p) return 0;
    const W = weights().pitching;
    return (
      outsOf(p) * W.OUT +
      n(p.strikeOuts) * W.SO +
      n(p.wins) * W.W +
      (isQualityStart(p) ? W.QS : 0) +
      n(p.saves) * W.SV +
      n(p.holds) * W.HLD +
      n(p.completeGames) * W.CG +
      n(p.shutouts) * W.SHO +
      n(p.earnedRuns) * W.ER +
      n(p.hits) * W.H +
      n(p.baseOnBalls) * W.BB
    );
  }

  // Total for a player-day (two-way players can have both lines).
  function scoreLine(line) {
    return scoreHitting(line && line.batting) + scorePitching(line && line.pitching);
  }

  // Round to 1 decimal for display/storage (points are integers unless a rule
  // changes, but keep this tolerant).
  const round1 = (x) => Math.round(x * 10) / 10;

  return { scoreHitting, scorePitching, scoreLine, isQualityStart, outsOf, round1 };
});
