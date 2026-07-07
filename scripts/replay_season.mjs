#!/usr/bin/env node
/*
 * Replay real MLB days through the scoring engine — the backtest that proves
 * the whole pipeline (statsapi parsing → shared/scoring.js) before it ever
 * runs live. No Firebase needed; read-only against the public API.
 *
 *   node scripts/replay_season.mjs --date 2026-06-15
 *   node scripts/replay_season.mjs --date 2026-06-15 --end 2026-06-21   # a whole week
 *   node scripts/replay_season.mjs --date 2026-06-15 --player 660271    # one player's line
 *
 * Cross-check the printed lines against the real box scores on mlb.com —
 * QS/holds/doubleheaders are the cases worth eyeballing.
 */
import Scoring from "../shared/scoring.js";
import * as MLB from "../netlify/functions/lib/mlb.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const START = arg("date");
const END = arg("end", START);
const PLAYER = arg("player", null);
if (!START) { console.error("usage: replay_season.mjs --date YYYY-MM-DD [--end YYYY-MM-DD] [--player mlbId]"); process.exit(1); }

const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const seasonTotals = {};

for (let date = START; date <= END; date = addDays(date, 1)) {
  const games = await MLB.scheduleForDate(date);
  const done = games.filter((g) => g.status === "Final");
  console.log(`\n=== ${date} — ${games.length} games (${done.length} final) ===`);
  if (!done.length) continue;

  // Merge doubleheaders per player, exactly like the ingest function.
  const byPlayer = {};
  for (const g of done) {
    const [box, dec] = await Promise.all([MLB.boxscore(g.gamePk), MLB.gameDecisions(g.gamePk)]);
    Object.entries(MLB.extractStatLines(box, dec)).forEach(([id, line]) => {
      const cur = byPlayer[id];
      if (!cur) { byPlayer[id] = { ...line, games: 1 }; return; }
      cur.games++;
      ["batting", "pitching"].forEach((k) => {
        if (!line[k]) return;
        if (!cur[k]) { cur[k] = { ...line[k] }; return; }
        Object.entries(line[k]).forEach(([f, v]) => {
          if (typeof v === "number" && f !== "outs") cur[k][f] = (cur[k][f] || 0) + v;
        });
        cur[k].outs = (Scoring.outsOf(cur[k]) || 0); // keep outs coherent
      });
    });
  }

  const scored = Object.entries(byPlayer).map(([id, line]) => ({
    id, name: line.name,
    pts: Scoring.round1(Scoring.scoreLine(line)),
    line,
  }));
  scored.forEach((s) => { seasonTotals[s.name] = Math.round(((seasonTotals[s.name] || 0) + s.pts) * 10) / 10; });

  if (PLAYER) {
    const s = scored.find((x) => x.id === String(PLAYER));
    console.log(s ? JSON.stringify(s, null, 2) : `player ${PLAYER} did not play`);
    continue;
  }

  const hitters = scored.filter((s) => s.line.batting && !s.line.pitching).sort((a, b) => b.pts - a.pts).slice(0, 8);
  const pitchers = scored.filter((s) => s.line.pitching).sort((a, b) => b.pts - a.pts).slice(0, 8);
  console.log("Top hitters:");
  hitters.forEach((s) => {
    const b = s.line.batting;
    console.log(`  ${String(s.pts).padStart(5)}  ${s.name}  (${b.hits}H ${b.homeRuns}HR ${b.runs}R ${b.rbi}RBI ${b.stolenBases}SB ${b.strikeOuts}K)`);
  });
  console.log("Top pitchers:");
  pitchers.forEach((s) => {
    const p = s.line.pitching;
    const qs = Scoring.isQualityStart(p) ? " QS" : "";
    const dec = [p.wins ? "W" : "", p.saves ? "SV" : "", p.holds ? "HLD" : ""].filter(Boolean).join(",");
    console.log(`  ${String(s.pts).padStart(5)}  ${s.name}  (${p.inningsPitched}IP ${p.strikeOuts}K ${p.earnedRuns}ER${qs}${dec ? " " + dec : ""})`);
  });
}

if (START !== END && !PLAYER) {
  console.log("\n=== Range leaders ===");
  Object.entries(seasonTotals).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([name, pts]) => console.log(`  ${String(pts).padStart(6)}  ${name}`));
}
