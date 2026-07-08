/*
 * Nightly player-universe sync (daily-rollover):
 *   1. 40-man rosters of all 30 clubs → club, IL status, new arrivals
 *   2. yesterday's statlines → appearance counters (position games, GS, relief)
 *   3. recompute positions[] + eligibleSlots per the league eligibility rules
 */
import Scoring from "../../../shared/scoring.js";
import { db, leagueRef } from "./firebase.mjs";
import { CFG } from "./league.mjs";
import * as MLB from "./mlb.mjs";
import { computePositions, eligibleSlots, normalizeAppearances } from "./eligibility.mjs";

// Yahoo-style two-way splits: these person ids live as "{id}:B" + "{id}:P".
const TWO_WAY = new Set((CFG.TWO_WAY_PLAYERS || []).map(String));

export async function syncPlayers(yesterday, season) {
  const L = leagueRef();

  // ---- 1. club rosters + IL ----
  const clubs = await MLB.allTeams(season);
  const abbrOf = Object.fromEntries(clubs.map((c) => [c.id, c.abbreviation]));
  const rosterEntries = [];
  for (const c of clubs) {
    try {
      const roster = await MLB.roster40(c.id, season);
      roster.forEach((r) => rosterEntries.push({ ...r, teamId: c.id }));
    } catch (e) {
      console.warn(`roster fetch failed for ${c.name}: ${e.message}`);
    }
  }

  // ---- existing player docs ----
  const existing = {};
  (await L.collection("players").get()).forEach((d) => { existing[d.id] = d.data(); });

  // For two-way people, updates accumulate on a merged view of the two split
  // docs (batting counters from :B, pitching from :P), split back out below.
  TWO_WAY.forEach((pid) => {
    if (existing[pid]) return;
    const b = existing[`${pid}:B`], p = existing[`${pid}:P`];
    if (!b && !p) return;
    existing[pid] = {
      ...(p || {}), ...(b || {}),
      apprThisSeason: (b || {}).apprThisSeason || {},
      gsThisSeason: (p || {}).gsThisSeason || 0,
      reliefThisSeason: (p || {}).reliefThisSeason || 0,
      pitchedThisSeason: (p || {}).pitchedThisSeason || 0,
      // running season points, kept per half (batting on :B, pitching on :P)
      seasonPointsB: (b || {}).seasonPoints || 0,
      seasonPointsP: (p || {}).seasonPoints || 0,
    };
    delete existing[pid].rosteredBy; // ownership lives on the split docs
  });

  // ---- 2. appearance counters from yesterday's lines ----
  const statSnap = yesterday
    ? await L.collection("statlines").where("date", "==", yesterday).get()
    : { forEach: () => {} };
  const played = {};
  statSnap.forEach((d) => { played[String(d.data().mlbId)] = d.data(); });

  const updates = {};
  const touch = (id) => (updates[id] = updates[id] || { ...(existing[id] || {}) });

  rosterEntries.forEach((r) => {
    if (!r.mlbId) return;
    const u = touch(String(r.mlbId));
    u.name = r.name || u.name || "";
    u.mlbTeamId = r.teamId;
    u.mlbTeam = abbrOf[r.teamId] || "";
    u.primary = r.position || u.primary || "";
    u.ilStatus = MLB.ilStatusFromCode(r.statusCode);
    u.statusDescription = r.statusDescription || "";
  });

  Object.entries(played).forEach(([id, line]) => {
    const u = touch(id);
    if (!u.name) u.name = line.name || "";
    if (!u.mlbTeamId) { u.mlbTeamId = line.teamId; u.mlbTeam = abbrOf[line.teamId] || ""; }
    if (u.lastCountedDate === yesterday) return; // idempotent re-runs
    if (line.batting) {
      const appr = { ...(u.apprThisSeason || {}) };
      (line.fieldPositions || []).forEach((pos) => {
        if (pos === "P") return;
        appr[pos] = (appr[pos] || 0) + 1;
      });
      u.apprThisSeason = appr;
    }
    if (line.pitching) {
      u.pitchedThisSeason = (u.pitchedThisSeason || 0) + 1;
      if (line.pitching.gamesStarted) u.gsThisSeason = (u.gsThisSeason || 0) + 1;
      else u.reliefThisSeason = (u.reliefThisSeason || 0) + 1;
    }
    // Running season fantasy points (raw, before any team-level start cap). Two-
    // way people keep the halves apart; everyone else uses the whole line.
    if (TWO_WAY.has(id)) {
      if (line.batting) u.seasonPointsB = Scoring.round1((u.seasonPointsB || 0) + Scoring.scoreHitting(line.batting));
      if (line.pitching) u.seasonPointsP = Scoring.round1((u.seasonPointsP || 0) + Scoring.scorePitching(line.pitching));
    } else {
      u.seasonPoints = Scoring.round1((u.seasonPoints || 0) + (line.points || 0));
    }
    u.lastCountedDate = yesterday;
  });

  // ---- split two-way people back into their :B / :P fantasy players ----
  Object.keys(updates).filter((pid) => TWO_WAY.has(pid)).forEach((pid) => {
    const u = updates[pid];
    delete updates[pid];
    const baseName = String(u.name || "").replace(/ \((Batter|Pitcher)\)$/, "");
    [["B", "Batter"], ["P", "Pitcher"]].forEach(([role, label]) => {
      const key = `${pid}:${role}`;
      const prev = existing[key] || {};
      updates[key] = {
        ...prev, ...u,
        name: `${baseName} (${label})`,
        personId: +pid, twoWayRole: role,
        rosteredBy: prev.rosteredBy ?? null,          // each half has its own owner
        seasonPoints: role === "B" ? (u.seasonPointsB || 0) : (u.seasonPointsP || 0),
      };
      delete updates[key].seasonPointsB;
      delete updates[key].seasonPointsP;
    });
  });

  // ---- 3. recompute eligibility ----
  Object.values(updates).forEach((u) => {
    // Season-start eligibility (basePositions) is never lost mid-year; the
    // stats-driven recompute only ADDS positions on top of it.
    u.positions = [...new Set([...(u.basePositions || []), ...computePositions(u)])];
    if (u.twoWayRole === "B") {
      u.positions = u.positions.filter((p) => !["SP", "RP"].includes(p));
      if (!u.positions.length) u.positions = ["DH"];
    } else if (u.twoWayRole === "P") {
      u.positions = u.positions.filter((p) => ["SP", "RP"].includes(p));
      if (!u.positions.length) u.positions = ["SP"];
    }
    u.eligibleSlots = eligibleSlots(u.positions);
    u.apprThisSeason = normalizeAppearances(u.apprThisSeason);
    if (u.rosteredBy === undefined) u.rosteredBy = null;
  });

  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = db().batch();
    entries.slice(i, i + 450).forEach(([id, u]) =>
      batch.set(L.collection("players").doc(id), { ...u, updatedAt: new Date().toISOString() }, { merge: true }));
    await batch.commit();
  }
  return entries.length;
}
