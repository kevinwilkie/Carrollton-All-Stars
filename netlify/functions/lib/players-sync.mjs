/*
 * Nightly player-universe sync (daily-rollover):
 *   1. 40-man rosters of all 30 clubs → club, IL status, new arrivals
 *   2. yesterday's statlines → appearance counters (position games, GS, relief)
 *   3. recompute positions[] + eligibleSlots per the league eligibility rules
 */
import { db, leagueRef } from "./firebase.mjs";
import * as MLB from "./mlb.mjs";
import { computePositions, eligibleSlots, normalizeAppearances } from "./eligibility.mjs";

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
    u.lastCountedDate = yesterday;
  });

  // ---- 3. recompute eligibility ----
  Object.values(updates).forEach((u) => {
    u.positions = computePositions(u);
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
