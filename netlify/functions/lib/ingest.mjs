/*
 * Stat ingestion: MLB schedule + boxscores → statlines with fantasy points,
 * lineup-lock snapshots as games start, and per-day score/matchup refresh.
 * Shared by ingest-stats (every 30 min) and daily-rollover (final pass).
 */
import Scoring from "../../../shared/scoring.js";
import { db, leagueRef } from "./firebase.mjs";
import { CFG, etDate, weekFor, datesOfWeek } from "./league.mjs";
import * as MLB from "./mlb.mjs";

// Unique slot keys for lineup docs: C,1B,2B,3B,SS,INF,OF1..OF4,UTIL1,UTIL2,
// SP1..SP4,RP1..RP4,BN1..BN6,IL1..IL4. slotType("OF3") === "OF".
export function slotKeys() {
  const keys = [];
  const counts = {};
  CFG.LINEUP_SLOTS.forEach((s) => {
    counts[s] = (counts[s] || 0) + 1;
    keys.push(CFG.LINEUP_SLOTS.filter((x) => x === s).length > 1 ? `${s}${counts[s]}` : s);
  });
  for (let i = 1; i <= CFG.BENCH_SLOTS; i++) keys.push(`BN${i}`);
  for (let i = 1; i <= CFG.IL_SLOTS; i++) keys.push(`IL${i}`);
  return keys;
}
export function slotType(slotKey) {
  return String(slotKey || "").replace(/\d+$/, "");
}
export function isActiveSlot(slotKey) {
  const t = slotType(slotKey);
  return t !== "BN" && t !== "IL" && t !== "";
}

// ---- mlbdays (game times = lock times) ---------------------------------------
export async function ensureMlbDay(date, { refresh = false } = {}) {
  const ref = leagueRef().collection("mlbdays").doc(date);
  const snap = await ref.get();
  if (snap.exists && !refresh) return snap.data().games || [];
  const fresh = await MLB.scheduleForDate(date);
  const prior = snap.exists ? snap.data().games || [] : [];
  const locksDone = Object.fromEntries(prior.map((g) => [g.gamePk, !!g.locksDone]));
  const games = fresh.map((g) => ({ ...g, locksDone: locksDone[g.gamePk] || false }));
  await ref.set({ date, games, updatedAt: new Date().toISOString() });
  return games;
}

// ---- lineup-lock snapshots -----------------------------------------------------
// For every game whose first pitch has passed, freeze each fantasy team's
// current slot for the players on those MLB clubs. Scoring reads ONLY the
// locked map, so later client edits of a locked player are inert.
export async function snapshotLocks(date) {
  const L = leagueRef();
  const dayRef = L.collection("mlbdays").doc(date);
  const daySnap = await dayRef.get();
  if (!daySnap.exists) return 0;
  const games = daySnap.data().games || [];
  const nowIso = new Date().toISOString();
  const started = games.filter((g) => g.firstPitchUTC && g.firstPitchUTC <= nowIso && !g.locksDone);
  if (!started.length) return 0;

  const startedClubs = new Set();
  started.forEach((g) => { startedClubs.add(g.homeId); startedClubs.add(g.awayId); });

  const playersSnap = await L.collection("players").where("rosteredBy", "!=", null).get();
  const clubOf = {};
  playersSnap.forEach((d) => { clubOf[d.id] = d.data().mlbTeamId; });

  const batch = db().batch();
  for (const t of CFG.LEAGUE_TEAMS) {
    const lref = L.collection("lineups").doc(`${t.id}_${date}`);
    const lsnap = await lref.get();
    if (!lsnap.exists) continue;
    const lu = lsnap.data();
    const locked = { ...(lu.locked || {}) };
    let changed = false;
    Object.entries(lu.slots || {}).forEach(([slot, mlbId]) => {
      if (!mlbId) return;
      const id = String(mlbId);
      if (locked[id]) return;
      if (startedClubs.has(clubOf[id])) { locked[id] = slot; changed = true; }
    });
    if (changed) batch.set(lref, { locked }, { merge: true });
  }
  games.forEach((g) => { if (started.includes(g)) g.locksDone = true; });
  batch.set(dayRef, { games }, { merge: true });
  await batch.commit();
  return started.length;
}

// ---- boxscores → statlines ------------------------------------------------------
export async function ingestStatlines(date, games) {
  const L = leagueRef();
  const playable = games.filter((g) => g.status === "Live" || g.status === "Final");
  if (!playable.length) return 0;

  // Merge doubleheaders: one statline per player per ET date.
  const byPlayer = {};
  const results = await Promise.all(playable.map(async (g) => {
    const [box, decisions] = await Promise.all([
      MLB.boxscore(g.gamePk),
      g.status === "Final" ? MLB.gameDecisions(g.gamePk) : Promise.resolve({}),
    ]);
    return { g, lines: MLB.extractStatLines(box, decisions) };
  }));
  const finalFor = {}; // mlbId -> all of that player's games today are Final
  results.forEach(({ g, lines }) => {
    Object.entries(lines).forEach(([id, line]) => {
      const cur = byPlayer[id] || { name: line.name, teamId: line.teamId, gamePks: [], fieldPositions: [] };
      cur.gamePks.push(g.gamePk);
      cur.fieldPositions = [...new Set(cur.fieldPositions.concat(line.fieldPositions || []))];
      if (line.batting) cur.batting = sumStats(cur.batting, line.batting);
      if (line.pitching) cur.pitching = sumStats(cur.pitching, line.pitching);
      finalFor[id] = (finalFor[id] !== false) && g.status === "Final";
      byPlayer[id] = cur;
    });
  });

  // Batched writes (Firestore caps batches at 500 ops).
  const entries = Object.entries(byPlayer);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = db().batch();
    entries.slice(i, i + 450).forEach(([id, line]) => {
      const points = Scoring.round1(Scoring.scoreLine(line));
      batch.set(L.collection("statlines").doc(`${date}_${id}`), {
        date, mlbId: +id, name: line.name, teamId: line.teamId,
        gamePks: line.gamePks, fieldPositions: line.fieldPositions,
        batting: line.batting || null, pitching: line.pitching || null,
        points, final: !!finalFor[id],
        updatedAt: new Date().toISOString(),
      });
    });
    await batch.commit();
  }
  return entries.length;
}

function sumStats(a, b) {
  if (!a) return { ...b };
  const out = { ...a };
  Object.entries(b).forEach(([k, v]) => {
    if (k === "inningsPitched") return;              // recomputed from outs below
    out[k] = typeof v === "number" ? (out[k] || 0) + v : v;
  });
  if (a.outs != null || b.outs != null || a.inningsPitched || b.inningsPitched) {
    const outs = (Scoring.outsOf(a) || 0) + (Scoring.outsOf(b) || 0);
    out.outs = outs;
    out.inningsPitched = `${Math.floor(outs / 3)}.${outs % 3}`;
  }
  return out;
}

// ---- per-day scoring → scores/{team}_{week} + matchups ---------------------------
export async function recomputeScores(date) {
  const L = leagueRef();
  const settings = (await L.collection("config").doc("settings").get()).data() || {};
  const week = weekFor(date, settings.weeks);
  if (!week) return null;

  // Stat lines per MLB person for the date. Roster ids may be two-way splits
  // ("660271:B"/"660271:P") — those score only their half of the person's line.
  const statSnap = await L.collection("statlines").where("date", "==", date).get();
  const stats = {};
  statSnap.forEach((d) => { stats[String(d.data().mlbId)] = d.data(); });
  const pointsFor = (rosterId) => {
    const [person, role] = String(rosterId).split(":");
    const line = stats[person];
    if (!line) return 0;
    if (role === "B") return Scoring.round1(Scoring.scoreHitting(line.batting));
    if (role === "P") return Scoring.round1(Scoring.scorePitching(line.pitching));
    return line.points || 0;
  };

  const dayPoints = {};   // teamId -> points for `date`
  const dayDetail = {};   // teamId -> { rosterId: {slot, points} }
  for (const t of CFG.LEAGUE_TEAMS) {
    const lsnap = await L.collection("lineups").doc(`${t.id}_${date}`).get();
    const locked = lsnap.exists ? lsnap.data().locked || {} : {};
    let total = 0;
    const detail = {};
    Object.entries(locked).forEach(([mlbId, slot]) => {
      if (!isActiveSlot(slot)) return;
      const p = pointsFor(mlbId);
      total += p;
      if (p) detail[mlbId] = { slot, points: p };
    });
    dayPoints[t.id] = Math.round(total * 10) / 10;
    dayDetail[t.id] = detail;
  }

  // Fold the day into each team's week score doc.
  const weekTotals = {};
  const batch = db().batch();
  for (const t of CFG.LEAGUE_TEAMS) {
    const ref = L.collection("scores").doc(`${t.id}_${week.n}`);
    const snap = await ref.get();
    const byDay = snap.exists ? snap.data().byDay || {} : {};
    byDay[date] = dayPoints[t.id];
    const total = Math.round(Object.values(byDay).reduce((s, v) => s + v, 0) * 10) / 10;
    weekTotals[t.id] = total;
    const byPlayerDays = snap.exists ? snap.data().byPlayerDays || {} : {};
    byPlayerDays[date] = dayDetail[t.id];
    batch.set(ref, { teamId: t.id, week: week.n, byDay, byPlayerDays, total, updatedAt: new Date().toISOString() });
  }

  // Live matchup totals.
  const schedSnap = await L.collection("schedule").doc(String(week.n)).get();
  const matchups = schedSnap.exists ? schedSnap.data().matchups || [] : [];
  matchups.forEach((mu, i) => {
    if (!mu.home || !mu.away) return; // playoff slot not decided yet
    batch.set(L.collection("matchups").doc(`${week.n}_${i}`), {
      week: week.n, index: i, label: mu.label || null,
      home: mu.home, away: mu.away,
      homePts: weekTotals[mu.home] ?? 0,
      awayPts: weekTotals[mu.away] ?? 0,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  });
  await batch.commit();
  return week;
}

// One full pass for a date: schedule refresh → locks → stats → scores.
export async function ingestDate(date) {
  const games = await ensureMlbDay(date, { refresh: true });
  if (!games.length) return { date, games: 0, statlines: 0 };
  const locked = await snapshotLocks(date);
  const statlines = await ingestStatlines(date, games);
  if (statlines) await recomputeScores(date);
  return { date, games: games.length, locked, statlines };
}
