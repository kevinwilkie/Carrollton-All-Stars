#!/usr/bin/env node
/*
 * Build the draft player pool from the MLB Stats API.
 *
 *   node scripts/build_player_pool.mjs --season 2026 --out draft/data/players.js --top 700
 *
 * For every player on a 40-man roster: position eligibility from that season's
 * fielding/pitching splits (10+ games at a position; SP/RP from starts vs
 * relief), and a draft `rank` from the player's total fantasy points under OUR
 * scoring. Emits draft/data/players.js. Run it in the offseason before the
 * draft (needs internet; ~1 minute).
 */
import { writeFileSync } from "node:fs";
import Scoring from "../shared/scoring.js";
import cfg from "../shared/league-config.js";
import * as MLB from "../netlify/functions/lib/mlb.mjs";
import { computePositions } from "../netlify/functions/lib/eligibility.mjs";

// Two-way players are drafted as TWO entries (Yahoo-style): "{id}:B" bats,
// "{id}:P" pitches — each ranked by its half's fantasy points.
const TWO_WAY = new Set((cfg.TWO_WAY_PLAYERS || []).map(String));

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SEASON = +arg("season", new Date().getFullYear());
const OUT = arg("out", "draft/data/players.js");
const TOP = +arg("top", 700);

const num = (v) => (Number.isFinite(+v) ? +v : 0);

async function main() {
  console.log(`Building player pool from the ${SEASON} season…`);
  const clubs = await MLB.allTeams(SEASON);
  const abbrOf = Object.fromEntries(clubs.map((c) => [c.id, c.abbreviation]));

  // 40-man rosters (~1200 players)
  const players = [];
  for (const c of clubs) {
    const roster = await MLB.roster40(c.id, SEASON);
    roster.forEach((r) => r.mlbId && players.push({ ...r, teamId: c.id }));
    process.stdout.write(`  ${c.abbreviation}: ${roster.length}\n`);
  }

  // Season splits: fielding games by position, pitching GS/G, and full
  // hitting/pitching lines for the fantasy-point ranking.
  console.log(`Fetching season stats for ${players.length} players…`);
  const statsById = {};
  const ids = players.map((p) => p.mlbId);
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).join(",");
    const d = await MLB.fetchJson(
      `https://statsapi.mlb.com/api/v1/people?personIds=${chunk}` +
      `&hydrate=stats(group=[hitting,pitching,fielding],type=[season],season=${SEASON})`
    );
    (d.people || []).forEach((p) => {
      const rec = { fielding: {}, pitching: null, hitLine: null, pitchLine: null, primary: p.primaryPosition?.abbreviation || "" };
      (p.stats || []).forEach((s) => {
        const group = s.group?.displayName;
        (s.splits || []).forEach((sp) => {
          if (group === "fielding") {
            const pos = sp.position?.abbreviation;
            if (pos && pos !== "P") rec.fielding[pos] = (rec.fielding[pos] || 0) + num(sp.stat?.games);
          } else if (group === "pitching") {
            rec.pitching = { games: num(sp.stat?.gamesPlayed), gamesStarted: num(sp.stat?.gamesStarted) };
            rec.pitchLine = sp.stat;
          } else if (group === "hitting") {
            rec.hitLine = sp.stat;
          }
        });
      });
      statsById[p.id] = rec;
    });
    process.stdout.write(`  stats ${Math.min(i + 40, ids.length)}/${ids.length}\r`);
  }
  console.log();

  // Eligibility + fantasy-point ranking.
  const pool = players.flatMap((p) => {
    const s = statsById[p.mlbId] || { fielding: {}, pitching: null, primary: p.position };
    const positions = computePositions({
      primary: s.primary || p.position,
      apprLastSeason: s.fielding,
      apprThisSeason: {},
      gsLastSeason: s.pitching?.gamesStarted || 0,
      reliefLastSeason: Math.max(0, (s.pitching?.games || 0) - (s.pitching?.gamesStarted || 0)),
      pitchedLastSeason: s.pitching?.games || 0,
    });
    // Season totals under our scoring (QS unavailable in season lines —
    // ranking only, so approximate with half the starts as quality).
    const hitPts = s.hitLine ? Scoring.scoreHitting(s.hitLine) : 0;
    const pitchPts = s.pitchLine
      ? Scoring.scorePitching({ ...s.pitchLine, gamesStarted: 0 }) +
        (s.pitching?.gamesStarted || 0) * 0.5 * 5 // QS estimate
      : 0;
    const base = {
      team: abbrOf[p.teamId] || "",
      il: p.statusCode && /^D/i.test(p.statusCode),
    };
    if (TWO_WAY.has(String(p.mlbId))) {
      const hitPos = positions.filter((x) => !["SP", "RP"].includes(x));
      const armPos = positions.filter((x) => ["SP", "RP"].includes(x));
      return [
        { ...base, id: `${p.mlbId}:B`, name: `${p.name} (Batter)`,
          positions: hitPos.length ? hitPos : ["DH"], points: Math.round(hitPts) },
        { ...base, id: `${p.mlbId}:P`, name: `${p.name} (Pitcher)`,
          positions: armPos.length ? armPos : ["SP"], points: Math.round(pitchPts) },
      ];
    }
    return [{ ...base, id: p.mlbId, name: p.name, positions, points: Math.round(hitPts + pitchPts) }];
  });

  pool.sort((a, b) => b.points - a.points);
  const top = pool.slice(0, TOP);
  top.forEach((p, i) => { p.rank = i + 1; });
  top.sort((a, b) => a.team.localeCompare(b.team) || a.rank - b.rank);

  const lines = [];
  let lastTeam = "";
  top.forEach((p) => {
    if (p.team !== lastTeam) { lines.push(`  // ---- ${p.team} ----`); lastTeam = p.team; }
    lines.push(`  { id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, team: ${JSON.stringify(p.team)}, ` +
      `positions: ${JSON.stringify(p.positions)}, rank: ${p.rank} },`);
  });

  const header = `/*
 * Carrollton All-Stars — Draft Player Pool (GENERATED ${new Date().toISOString().slice(0, 10)})
 * Source: MLB Stats API, ${SEASON} season. Top ${TOP} by fantasy points under
 * league scoring. Regenerate: node scripts/build_player_pool.mjs --season ${SEASON}
 * Eligibility: 10+ games at a position in ${SEASON}; SP/RP from starts vs relief.
 */
const PLAYERS = [
`;
  writeFileSync(OUT, header + lines.join("\n") + "\n];\n");
  console.log(`Wrote ${top.length} players → ${OUT}`);
  const multi = top.filter((p) => p.positions.length > 1).length;
  console.log(`  multi-position: ${multi} · IL right now: ${top.filter((p) => p.il).length}`);
  console.log(`  top 5: ${pool.slice(0, 5).map((p) => `${p.name} (${p.points})`).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
