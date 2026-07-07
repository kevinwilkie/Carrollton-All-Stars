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
function subscribeCore() {
  clearUnsubs(App.unsubs);
  App.unsubs.push(
    L().collection("config").doc("settings").onSnapshot((d) => {
      App.settings = d.exists ? d.data() : null;
      subscribeWeek();
      renderShell();
      renderActive();
    }),
    L().collection("teams").onSnapshot((snap) => {
      snap.forEach((d) => { App.teams[d.id] = d.data(); });
      renderShell();
      renderActive();
    }),
    L().collection("trades").onSnapshot((snap) => {
      App.trades = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderActive();
    }),
    L().collection("transactions").orderBy("at", "desc").limit(120).onSnapshot((snap) => {
      App.transactions = snap.docs.map((d) => d.data());
      renderActive();
    }, () => {}),
  );
  if (App.myTeamId) {
    App.unsubs.push(
      L().collection("claims").where("teamId", "==", App.myTeamId).onSnapshot((snap) => {
        App.claims = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.placedAt || "").localeCompare(a.placedAt || ""));
        renderActive();
      }),
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
  });
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
      }),
    );
  }
  App.dayUnsubs.push(
    L().collection("mlbdays").doc(App.date).onSnapshot((d) => {
      App.mlbDay = d.exists ? d.data() : null;
      renderActive();
    }),
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

// ---- writes -----------------------------------------------------------------------
async function saveLineupSlots(slots) {
  const ref = L().collection("lineups").doc(`${App.myTeamId}_${App.date}`);
  if (App.lineup) {
    await ref.update({ slots, updatedAt: new Date().toISOString() });
  } else {
    await ref.set({ teamId: App.myTeamId, date: App.date, slots, updatedAt: new Date().toISOString() });
  }
}

async function placeClaim(player, bid, dropId) {
  await L().collection("claims").add({
    teamId: App.myTeamId,
    add: +player.mlbId, addName: player.name, addPositions: player.positions || [],
    drop: dropId ? +dropId : null,
    bid: Math.round(bid),
    forDate: claimProcessDate(),
    status: "pending",
    placedAt: new Date().toISOString(),
  });
}

async function cancelClaim(id) {
  await L().collection("claims").doc(id).delete();
}

async function proposeTrade(to, gives, gets) {
  await L().collection("trades").add({
    from: App.myTeamId, to, gives, gets,
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
  await L().collection("trades").doc(id).update({
    ["vetoes." + App.myTeamId]: on ? true : firebase.firestore.FieldValue.delete(),
  });
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
