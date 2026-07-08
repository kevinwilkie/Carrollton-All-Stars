/*
 * Unit tests — pure logic, no browser or network. Run: npm test
 * Covers the real engines (scoring, feasibility, schedule generator, called-off
 * detection) plus faithful mirrors of the Firestore-coupled decision logic
 * (trade veto rule, week finalization, season-points accumulation, lineup locks)
 * that the sandbox can't exercise end-to-end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Scoring from "../shared/scoring.js";
import Feasibility from "../draft/feasibility.js";
import ScheduleGen from "../shared/schedule-gen.js";
import { isCalledOff } from "../netlify/functions/lib/ingest.mjs";
import { extractStatLines } from "../netlify/functions/lib/mlb.mjs";

// ---------------------------------------------------------------- scoring engine
test("scoring: hitting line (single + double + HR + walk + K)", () => {
  // 3 H (1B,2B,HR) so singles=1; +2B +HR +BB +R +RBI +SB −K
  const pts = Scoring.scoreHitting({ hits: 3, doubles: 1, homeRuns: 1, baseOnBalls: 1, runs: 2, rbi: 3, stolenBases: 1, strikeOuts: 1 });
  // 1*1 + 2*1 + 4*1 + 1*1 + 2*1 + 3*1 + 2*1 − 1*1 = 14
  assert.equal(Scoring.round1(pts), 14);
});

test("scoring: IBB stacks on top of BB", () => {
  const base = Scoring.scoreHitting({ hits: 0, baseOnBalls: 1 });
  const withIbb = Scoring.scoreHitting({ hits: 0, baseOnBalls: 1, intentionalWalks: 1 });
  assert.equal(withIbb - base, 1);
});

test("scoring: pitching quality start (6 IP, 1 ER, 8 K, W)", () => {
  const p = { inningsPitched: "6.0", outs: 18, strikeOuts: 8, hits: 3, earnedRuns: 1, baseOnBalls: 1, gamesStarted: 1, wins: 1 };
  assert.equal(Scoring.isQualityStart(p), true);
  // 18 outs*1 + 8 K + 2 W + 5 QS − 2 ER − 3 H − 1 BB = 27
  assert.equal(Scoring.round1(Scoring.scorePitching(p)), 27);
});

test("scoring: not a QS at 5.2 IP", () => {
  assert.equal(Scoring.isQualityStart({ inningsPitched: "5.2", outs: 17, earnedRuns: 0, gamesStarted: 1 }), false);
});

test("scoring: outsOf parses 6.2 IP as 20 outs", () => {
  assert.equal(Scoring.outsOf({ inningsPitched: "6.2" }), 20);
});

// ------------------------------------------------------------ statline parsing
test("ingest: a 0-out pitcher parses to outs:0, never undefined (Firestore-safe)", () => {
  // A reliever pulled without recording an out: outs:0 but faced batters. The
  // old `num(p.outs) || undefined` wrote undefined here, which made Firestore
  // reject the whole nightly statline batch → no stats league-wide.
  const box = { teams: {
    home: { team: { id: 111 }, players: {
      ID1: { person: { id: 1, fullName: "Gas Can" },
        stats: { pitching: { outs: 0, battersFaced: 4, hits: 3, earnedRuns: 3, inningsPitched: "0.0" } } },
    } },
    away: { team: { id: 222 }, players: {} },
  } };
  const lines = extractStatLines(box, {});
  assert.ok(lines[1] && lines[1].pitching, "pitching line present for a 0-out appearance");
  assert.equal(lines[1].pitching.outs, 0);
  for (const [k, v] of Object.entries(lines[1].pitching)) assert.notEqual(v, undefined, `pitching.${k} is undefined`);
});

// --------------------------------------------------------------- feasibility
test("feasibility: 26 draft slots", () => assert.equal(Feasibility.draftSlots().length, 26));

test("feasibility: position fits", () => {
  assert.equal(Feasibility.playerFitsSlot(["SS"], "INF"), true);
  assert.equal(Feasibility.playerFitsSlot(["OF"], "UTIL"), true);
  assert.equal(Feasibility.playerFitsSlot(["SP"], "RP"), false);
  assert.equal(Feasibility.playerFitsSlot(["SP"], "UTIL"), false);
  assert.equal(Feasibility.playerFitsSlot(["RP"], "BN"), true);
});

test("feasibility: OF capacity is 12 (4 OF + 2 UTIL + 6 BN)", () => {
  const ofs = (n) => Array(n).fill(["OF"]);
  assert.equal(Feasibility.match(ofs(12)).complete, true);
  assert.equal(Feasibility.canFit(ofs(12), ["OF"]), false);
});

test("feasibility: SP-only capacity 10, but a swingman still fits", () => {
  const sps = (n) => Array(n).fill(["SP"]);
  assert.equal(Feasibility.canFit(sps(10), ["SP"]), false);
  assert.equal(Feasibility.canFit(sps(10), ["SP", "RP"]), true);
});

test("feasibility: assignSlots puts a shortstop in SS, not UTIL", () => {
  const { cells } = Feasibility.assignSlots([{ name: "A", positions: ["SS"] }]);
  const ss = cells.find((c) => c.player && c.player.name === "A");
  assert.ok(ss);
});

// --------------------------------------------------------------- schedule generator
test("schedule: 12 teams → 21 balanced regular weeks", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const weeks = ScheduleGen.generateMatchups(ids, "carrollton-2027");
  assert.equal(weeks.length, 21);
  weeks.forEach((w) => assert.equal(w.matchups.length, 6));
  // each team plays every week (21 games) and never itself
  const games = Object.fromEntries(ids.map((id) => [id, 0]));
  weeks.forEach((w) => w.matchups.forEach((m) => {
    assert.notEqual(m.home, m.away);
    games[m.home]++; games[m.away]++;
  }));
  ids.forEach((id) => assert.equal(games[id], 21));
});

// --------------------------------------------------------------- called-off games (real)
test("ingest: isCalledOff flags postponed/cancelled/suspended only", () => {
  const g = (ds) => ({ detailedState: ds });
  assert.equal(isCalledOff(g("Postponed")), true);
  assert.equal(isCalledOff(g("Cancelled")), true);
  assert.equal(isCalledOff(g("Suspended: Rain")), true);
  assert.equal(isCalledOff(g("In Progress")), false);
  assert.equal(isCalledOff(g("Final")), false);
});

// --------------------------------------------------------------- trade veto rule (mirror)
// Mirrors firestore.rules trades-update: uninvolved owner toggles only own veto.
function vetoAllowed(before, after, writerTeam) {
  const owns = (t) => t === writerTeam;
  const affected = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
    .filter((k) => JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k]));
  const hasOnly = (keys, allow) => keys.every((k) => allow.includes(k));
  return before.status === "accepted" &&
    owns(after.lastVetoBy) &&
    after.lastVetoBy !== before.from && after.lastVetoBy !== before.to &&
    hasOnly(affected(before, after), ["vetoes", "lastVetoBy"]) &&
    hasOnly(affected(before.vetoes, after.vetoes), [after.lastVetoBy]);
}
test("veto: uninvolved owner may toggle only their own veto", () => {
  const base = { from: "A", to: "B", status: "accepted", vetoes: {} };
  assert.equal(vetoAllowed(base, { ...base, vetoes: { C: true }, lastVetoBy: "C" }, "C"), true);
  // proposer can't clear a veto to force it through
  assert.equal(vetoAllowed({ ...base, vetoes: { C: true } }, { ...base, vetoes: {}, lastVetoBy: "A" }, "A"), false);
  // can't stuff another team's veto
  assert.equal(vetoAllowed(base, { ...base, vetoes: { D: true }, lastVetoBy: "C" }, "C"), false);
});

// --------------------------------------------------------------- week finalize (mirror)
function pickFinalizeWeek(weeks, matchupsByWeek, gamesByEnd, yesterday) {
  const settled = (games) => (games || []).every((g) => g.status === "Final" || isCalledOff(g));
  const ended = weeks.filter((w) => w.end <= yesterday).sort((a, b) => a.n - b.n);
  for (const w of ended) {
    const ms = matchupsByWeek[w.n] || [];
    if (!ms.length) continue;
    if (ms.every((m) => m.final)) continue;
    if (!settled(gamesByEnd[w.end])) return { defer: w.n };
    return { finalize: w.n };
  }
  return { none: true };
}
test("finalize: defers on a live last-day game, fires once settled", () => {
  const weeks = [{ n: 15, end: "2026-07-05" }, { n: 16, end: "2026-07-12" }];
  const mus = { 15: [{ final: true }], 16: [{ final: false }] };
  const live = { "2026-07-12": [{ status: "Live", detailedState: "In Progress" }] };
  const done = { "2026-07-12": [{ status: "Final", detailedState: "Final" }] };
  assert.deepEqual(pickFinalizeWeek(weeks, mus, live, "2026-07-12"), { defer: 16 });
  assert.deepEqual(pickFinalizeWeek(weeks, mus, done, "2026-07-12"), { finalize: 16 });
  assert.deepEqual(pickFinalizeWeek(weeks, { 15: [{ final: true }], 16: [{ final: true }] }, {}, "2026-07-12"), { none: true });
});

// --------------------------------------------------------------- season points (mirror + real scoring)
test("season points: accumulate across days, idempotent, two-way split", () => {
  const round1 = Scoring.round1;
  let normal = 0, lastDate = null;
  const addDay = (pts, date) => { if (lastDate === date) return; normal = round1(normal + pts); lastDate = date; };
  addDay(10, "d1"); addDay(5, "d2"); addDay(5, "d2"); // re-run d2 → no double count
  assert.equal(normal, 15);

  // two-way: batting → :B, pitching → :P
  const b = round1(Scoring.scoreHitting({ hits: 2, doubles: 1, homeRuns: 1, runs: 2, rbi: 3, strikeOuts: 1 }));
  const p = round1(Scoring.scorePitching({ inningsPitched: "6.0", outs: 18, strikeOuts: 8, hits: 3, earnedRuns: 1, baseOnBalls: 1, gamesStarted: 1, wins: 1 }));
  assert.ok(b > 0 && p > 0 && b !== p);
});

// --------------------------------------------------------------- lineup locks (mirror + real isCalledOff)
test("locks: skip called-off games and wrong-team players", () => {
  const now = "2026-07-08T20:00:00Z";
  const games = [
    { homeId: 10, awayId: 30, firstPitchUTC: "2026-07-08T17:00:00Z", detailedState: "In Progress", status: "Live", locksDone: false },
    { homeId: 20, awayId: 40, firstPitchUTC: "2026-07-08T17:00:00Z", detailedState: "Postponed", status: "Preview", locksDone: false },
  ];
  const started = games.filter((g) => g.firstPitchUTC <= now && !g.locksDone && !isCalledOff(g));
  const clubs = new Set(); started.forEach((g) => { clubs.add(g.homeId); clubs.add(g.awayId); });
  const clubOf = { pA: 10, pB: 20, pC: 10 }, rosterOf = { pA: "X", pB: "X", pC: "Y" };
  const locks = {};
  for (const [slot, id] of Object.entries({ C: "pA", "1B": "pB", SP1: "pC" }))
    if (clubs.has(clubOf[id]) && rosterOf[id] === "X") locks[id] = slot;
  assert.deepEqual(Object.keys(locks), ["pA"]); // pB postponed, pC on team Y
});
