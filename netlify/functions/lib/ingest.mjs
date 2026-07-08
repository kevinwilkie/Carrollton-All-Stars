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

// A game that won't actually be played today: postponed, cancelled, or
// suspended-before-resumption. Its clubs must NOT lock rosters — the game
// doesn't count, so owners keep those players swappable and they score 0.
export function isCalledOff(g) {
  const ds = (g.detailedState || "").toLowerCase();
  return ds.includes("postpon") || ds.includes("cancel") ||
    ds.includes("suspend") || ds.includes("forfeit");
}

// ---- lineup-lock snapshots -----------------------------------------------------
// For every game that has actually kicked off, freeze each fantasy team's
// current slot for the players on those MLB clubs. Scoring reads ONLY the
// locked map, so later client edits of a locked player are inert.
//
// Doubleheaders lock at the club level (both games share the same two clubs):
// once the club's FIRST game starts, all its players lock. That's intentional
// and standard for daily lineups — you can't know pre-game which game of a DH
// a player will appear in, so the earliest game is the safe lock point.
export async function snapshotLocks(date) {
  const L = leagueRef();
  const dayRef = L.collection("mlbdays").doc(date);
  const daySnap = await dayRef.get();
  if (!daySnap.exists) return 0;
  const games = daySnap.data().games || [];
  const nowIso = new Date().toISOString();
  const started = games.filter((g) =>
    g.firstPitchUTC && g.firstPitchUTC <= nowIso && !g.locksDone && !isCalledOff(g));
  if (!started.length) return 0;

  const startedClubs = new Set();
  started.forEach((g) => { startedClubs.add(g.homeId); startedClubs.add(g.awayId); });

  // Current club AND owner of each rostered player, so a player traded/dropped
  // before his game starts can't lock (and therefore can't score) for a team
  // that no longer holds him.
  const playersSnap = await L.collection("players").where("rosteredBy", "!=", null).get();
  const clubOf = {}, rosterOf = {};
  playersSnap.forEach((d) => { clubOf[d.id] = d.data().mlbTeamId; rosterOf[d.id] = d.data().rosteredBy; });

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
      if (startedClubs.has(clubOf[id]) && rosterOf[id] === t.id) { locked[id] = slot; changed = true; }
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
  if (!playable.length) return { count: 0, failed: [] };

  // Merge doubleheaders: one statline per player per ET date. Use allSettled so
  // one game's boxscore failing (a flaky MLB API call) doesn't discard the whole
  // slate — we ingest the games that succeeded and report the ones that didn't.
  const byPlayer = {};
  const settled = await Promise.allSettled(playable.map(async (g) => {
    const [box, decisions] = await Promise.all([
      MLB.boxscore(g.gamePk),
      g.status === "Final" ? MLB.gameDecisions(g.gamePk) : Promise.resolve({}),
    ]);
    return { g, lines: MLB.extractStatLines(box, decisions) };
  }));
  const failed = [];
  const results = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else { failed.push(playable[i].gamePk); console.error(`boxscore failed for gamePk ${playable[i].gamePk}:`, r.reason && r.reason.message || r.reason); }
  });
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
  return { count: entries.length, failed };
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

  // League rule: only the first N pitcher starts per team count each week.
  // Starts are ordered by first pitch; a capped start scores zero (any batting
  // by the same player still counts). Prior days' usage lives on the score doc.
  const startCap = (CFG.PITCHING && CFG.PITCHING.maxStartsPerWeek) || Infinity;
  const daySnap2 = await L.collection("mlbdays").doc(date).get();
  const firstPitchOf = {};
  ((daySnap2.exists && daySnap2.data().games) || []).forEach((g) => {
    firstPitchOf[g.gamePk] = g.firstPitchUTC || "9999";
  });

  const weekTotals = {};
  const batch = db().batch();
  for (const t of CFG.LEAGUE_TEAMS) {
    const lsnap = await L.collection("lineups").doc(`${t.id}_${date}`).get();
    const locked = lsnap.exists ? lsnap.data().locked || {} : {};

    const ref = L.collection("scores").doc(`${t.id}_${week.n}`);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : {};
    const byDay = prev.byDay || {};
    const byPlayerDays = prev.byPlayerDays || {};
    const byDayStarts = prev.byDayStarts || {};

    // Which of today's locked, active players started a game?
    const startsBefore = Object.entries(byDayStarts)
      .filter(([d]) => d < date)
      .reduce((s, [, arr]) => s + (arr ? arr.length : 0), 0);
    const starters = Object.entries(locked)
      .filter(([id, slot]) => {
        if (!isActiveSlot(slot)) return false;
        const [person, role] = String(id).split(":");
        if (role === "B") return false; // a split batter half never pitches
        const line = stats[person];
        return !!(line && line.pitching && line.pitching.gamesStarted);
      })
      .map(([id]) => {
        const gamePks = (stats[String(id).split(":")[0]].gamePks) || [];
        const t0 = gamePks.map((g) => firstPitchOf[g] || "9999").sort()[0] || "9999";
        return { id, t0 };
      })
      .sort((a, b) => (a.t0 < b.t0 ? -1 : 1));
    const allowed = Math.max(0, startCap - startsBefore);
    const countedStarts = starters.slice(0, allowed).map((s) => s.id);
    const cappedStarts = new Set(starters.slice(allowed).map((s) => s.id));

    let total = 0;
    const detail = {};
    Object.entries(locked).forEach(([mlbId, slot]) => {
      if (!isActiveSlot(slot)) return;
      let p;
      if (cappedStarts.has(mlbId)) {
        // Over the weekly start cap: pitching from this start doesn't count.
        const line = stats[String(mlbId).split(":")[0]];
        const role = String(mlbId).split(":")[1];
        p = role === "P" ? 0 : Scoring.round1(Scoring.scoreHitting(line && line.batting));
      } else {
        p = pointsFor(mlbId);
      }
      total += p;
      if (p || cappedStarts.has(mlbId))
        detail[mlbId] = { slot, points: p, ...(cappedStarts.has(mlbId) ? { cappedStart: true } : {}) };
    });

    byDay[date] = Math.round(total * 10) / 10;
    byPlayerDays[date] = detail;
    byDayStarts[date] = countedStarts;
    const weekTotal = Math.round(Object.values(byDay).reduce((s, v) => s + v, 0) * 10) / 10;
    const startsUsed = Object.values(byDayStarts).reduce((s, arr) => s + (arr ? arr.length : 0), 0);
    weekTotals[t.id] = weekTotal;
    batch.set(ref, {
      teamId: t.id, week: week.n, byDay, byPlayerDays, byDayStarts, startsUsed,
      total: weekTotal, updatedAt: new Date().toISOString(),
    });
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
  if (!games.length) return { date, games: 0, statlines: 0, failed: [] };
  const locked = await snapshotLocks(date);
  const { count, failed } = await ingestStatlines(date, games);
  if (count) await recomputeScores(date);
  return { date, games: games.length, locked, statlines: count, failed };
}
