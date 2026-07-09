/*
 * Season app — Firestore access layer. All paths live under leagues/carrollton.
 * Live listeners feed App.* and call renderActive(); one-shot fetches cache.
 * Every write here is also validated server-side by firestore.rules.
 */
"use strict";

function L() { return App.fs.collection("leagues").doc(LEAGUE.id); }

function apiInit() {
  const app = initFirebaseApp();
  if (!app || !firebase.firestore) return false;
  App.fs = firebase.firestore();
  return true;
}

function clearUnsubs(list) { list.splice(0).forEach((u) => { try { u(); } catch (e) {} }); }

// ---- core listeners (after sign-in resolves) ---------------------------------
// A live-listener error (usually a permissions/rules problem) shouldn't fail
// silently — surface it once so the user knows data may be stale.
function listenerError(what) {
  return (e) => { console.error(`listener [${what}]`, e); toast(`Live ${what} updates interrupted — reload if data looks stale.`, "error"); };
}

function subscribeCore() {
  clearUnsubs(App.unsubs);
  App.unsubs.push(
    L().collection("config").doc("settings").onSnapshot((d) => {
      App.settings = d.exists ? d.data() : null;
      subscribeWeek();
      renderShell();
      renderActive();
    }, listenerError("settings")),
    L().collection("teams").onSnapshot((snap) => {
      snap.forEach((d) => { App.teams[d.id] = d.data(); });
      renderShell();
      renderActive();
    }, listenerError("standings")),
    L().collection("trades").onSnapshot((snap) => {
      App.trades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderActive();
    }, listenerError("trade")),
    L().collection("transactions").orderBy("at", "desc").limit(120).onSnapshot((snap) => {
      App.transactions = snap.docs.map((d) => d.data());
      renderActive();
    }, listenerError("transaction")),
  );
  if (App.myTeamId) {
    App.unsubs.push(
      L().collection("claims").where("teamId", "==", App.myTeamId).onSnapshot((snap) => {
        App.claims = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.placedAt || "").localeCompare(a.placedAt || ""));
        renderActive();
      }, listenerError("waiver")),
    );
  }
  subscribeDay();
}

let weekUnsub = null;
function subscribeWeek() {
  const wk = currentWeek();
  if (weekUnsub) { weekUnsub(); weekUnsub = null; }
  if (!wk) { App.matchups = []; return; }
  weekUnsub = L().collection("matchups").where("week", "==", wk.n).onSnapshot((snap) => {
    App.matchups = snap.docs.map((d) => d.data()).sort((a, b) => (a.index || 0) - (b.index || 0));
    renderActive();
  }, listenerError("matchup"));
}

// ---- per-date listeners (My Team) ---------------------------------------------
function subscribeDay() {
  clearUnsubs(App.dayUnsubs);
  App.lineup = null;
  App.mlbDay = null;
  if (App.myTeamId) {
    App.dayUnsubs.push(
      L().collection("lineups").doc(`${App.myTeamId}_${App.date}`).onSnapshot((d) => {
        App.lineup = d.exists ? d.data() : null;
        renderActive();
      }, listenerError("lineup")),
    );
  }
  App.dayUnsubs.push(
    L().collection("mlbdays").doc(App.date).onSnapshot((d) => {
      App.mlbDay = d.exists ? d.data() : null;
      renderActive();
    }, listenerError("schedule")),
  );
}

// ---- one-shot fetches ------------------------------------------------------------
async function loadPlayers(force) {
  if (App.players && !force) return App.players;
  const snap = await L().collection("players").get();
  App.players = {};
  snap.forEach((d) => { App.players[d.id] = { mlbId: d.id, ...d.data() }; });
  App.playersArr = Object.values(App.players);
  return App.players;
}

async function loadRoster(teamId, force) {
  if (App.rosters[teamId] && !force) return App.rosters[teamId];
  const d = await L().collection("rosters").doc(teamId).get();
  App.rosters[teamId] = d.exists ? d.data() : { players: {} };
  return App.rosters[teamId];
}

async function loadScore(teamId, week, force) {
  const key = `${teamId}_${week}`;
  if (App.scores[key] && !force) return App.scores[key];
  const d = await L().collection("scores").doc(key).get();
  App.scores[key] = d.exists ? d.data() : { total: 0, byDay: {}, byPlayerDays: {} };
  return App.scores[key];
}

async function loadWeekSchedule(week) {
  const d = await L().collection("schedule").doc(String(week)).get();
  return d.exists ? d.data() : null;
}

// A player's game-by-game statlines, most recent first. Keyed by the MLB
// person id (two-way ":B"/":P" ids share one set of boxscore lines). Queried
// without a composite index — a season is ~160 docs — and cached per person.
const _gameLogCache = {};
async function loadGameLog(mlbId) {
  const personId = +(String(mlbId).match(/^\d+/) || [0])[0];
  if (!personId) return [];
  if (_gameLogCache[personId]) return _gameLogCache[personId];
  const snap = await L().collection("statlines").where("mlbId", "==", personId).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) => (a.date < b.date ? 1 : -1));
  _gameLogCache[personId] = rows;
  return rows;
}

// A player's season-by-season career stats (from the career Netlify function,
// which proxies the MLB API and scores each season). Cached per person+group.
const _careerCache = {};
async function loadCareer(mlbId, group) {
  const personId = +(String(mlbId).match(/^\d+/) || [0])[0];
  if (!personId) return null;
  const g = group === "pitching" ? "pitching" : "hitting";
  const key = personId + ":" + g;
  if (_careerCache[key]) return _careerCache[key];
  const res = await fetch(`/.netlify/functions/career?id=${personId}&group=${g}`);
  if (!res.ok) throw new Error(`career ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "career unavailable");
  _careerCache[key] = data;
  return data;
}

// ---- writes -----------------------------------------------------------------------
async function saveLineupSlots(slots) {
  const ref = L().collection("lineups").doc(`${App.myTeamId}_${App.date}`);
  if (App.lineup) {
    await ref.update({ slots, updatedAt: new Date().toISOString() });
  } else {
    await ref.set({ teamId: App.myTeamId, date: App.date, slots, updatedAt: new Date().toISOString() });
  }
}

// Instant drop — cut a player to a free agent now (adds still go through FAAB).
// Hits the roster-move function with the signed-in owner's ID token; the server
// verifies ownership and keeps roster + ownership + lineup consistent.
async function dropPlayer(mlbId) {
  if (!Auth.user) throw new Error("Sign in to manage your roster.");
  const idToken = await Auth.user.getIdToken();
  const res = await fetch("/.netlify/functions/roster-move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken, action: "drop", mlbId: String(mlbId) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Drop failed (${res.status}).`);
  return data;
}

async function placeClaim(player, bid, dropId) {
  await L().collection("claims").add({
    teamId: App.myTeamId,
    add: String(player.mlbId), addName: player.name, addPositions: player.positions || [],
    drop: dropId ? String(dropId) : null,
    bid: Math.round(bid),
    forDate: claimProcessDate(),
    status: "pending",
    placedAt: new Date().toISOString(),
  });
}

async function cancelClaim(id) {
  await L().collection("claims").doc(id).delete();
}

async function proposeTrade(to, gives, gets, note) {
  await L().collection("trades").add({
    from: App.myTeamId, to, gives, gets,
    note: note || null,
    status: "proposed",
    proposedAt: new Date().toISOString(),
    vetoes: {},
  });
}

async function respondTrade(id, accept) {
  const patch = accept
    ? { status: "accepted",
        reviewEndsAt: new Date(Date.now() + TRADE.reviewHours * 3600 * 1000).toISOString(),
        respondedAt: new Date().toISOString() }
    : { status: "rejected", respondedAt: new Date().toISOString(),
        reviewEndsAt: null };
  await L().collection("trades").doc(id).update(patch);
}

async function withdrawTrade(id) {
  await L().collection("trades").doc(id).update({ status: "withdrawn" });
}

async function vetoTrade(id, on) {
  // `lastVetoBy` names the writer's team so the rule can verify they own it,
  // aren't involved, and touched only their own veto entry.
  await L().collection("trades").doc(id).update({
    ["vetoes." + App.myTeamId]: on ? true : firebase.firestore.FieldValue.delete(),
    lastVetoBy: App.myTeamId,
  });
}

// Owner-editable team profile (name / picture / slogan). The security rules
// restrict this to your own team and to just these display fields.
async function saveTeamProfile(patch) {
  if (!App.myTeamId) throw new Error("No team to edit.");
  await L().collection("teams").doc(App.myTeamId).set(
    { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

async function saveKeeperDeclaration(season, entries) {
  await L().collection("keepers").doc(`${season}_${App.myTeamId}`).set({
    teamId: App.myTeamId, season, entries, updatedAt: new Date().toISOString(),
  });
}

async function loadKeeperDeclaration(season) {
  const d = await L().collection("keepers").doc(`${season}_${App.myTeamId}`).get();
  return d.exists ? d.data() : null;
}
