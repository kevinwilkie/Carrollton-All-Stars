/*
 * Season app — central state. Modules read/write App.* and call renderActive()
 * (js/render.js) after changes; Firestore snapshot listeners in js/api.js keep
 * it live. House style: plain globals, no framework.
 */
"use strict";

const App = {
  tab: "myteam",
  fs: null,                 // firestore instance (null in local mode)
  settings: null,           // leagues/carrollton/config/settings
  teams: {},                // teamId -> team doc (live)
  myTeamId: null,
  rosters: {},              // teamId -> roster doc (fetched on demand)
  players: null,            // full player cache: mlbId -> doc (fetched once)
  playersArr: [],
  lineup: null,             // my lineup doc for App.date
  mlbDay: null,             // mlbdays/{App.date} (lock times)
  matchups: [],             // current week's matchup docs (live)
  scores: {},               // `${teamId}_${week}` -> score doc (fetched on demand)
  claims: [],               // my pending/resolved claims (live)
  trades: [],               // all trades (live)
  transactions: [],         // recent transaction log (live)
  date: etDate(),           // the day being viewed/edited on My Team
  selectedSlot: null,       // lineup swap in progress
  unsubs: [],               // core listeners
  dayUnsubs: [],            // per-date listeners (lineup, mlbday)
};

function teamName(teamId) {
  return (App.teams[teamId] && App.teams[teamId].name) ||
    (LEAGUE_TEAMS.find((t) => t.id === teamId) || {}).name || teamId || "—";
}
function teamRecord(teamId) {
  const r = (App.teams[teamId] || {}).record || {};
  return `${r.w || 0}-${r.l || 0}${r.t ? "-" + r.t : ""}`;
}

function weekFor(dateISO) {
  const weeks = (App.settings && App.settings.weeks) || [];
  return weeks.find((w) => w.start <= dateISO && dateISO <= w.end) || null;
}
function currentWeek() { return weekFor(etDate()); }

function playerOf(mlbId) {
  return (App.players && App.players[String(mlbId)]) || null;
}

// Unique slot keys for lineup docs — must match netlify/functions/lib/ingest.mjs.
function slotKeys() {
  const keys = [];
  const counts = {};
  LINEUP_SLOTS.forEach((s) => {
    counts[s] = (counts[s] || 0) + 1;
    keys.push(LINEUP_SLOTS.filter((x) => x === s).length > 1 ? `${s}${counts[s]}` : s);
  });
  for (let i = 1; i <= BENCH_SLOTS; i++) keys.push(`BN${i}`);
  for (let i = 1; i <= IL_SLOTS; i++) keys.push(`IL${i}`);
  return keys;
}
const SLOT_KEYS = slotKeys();
function slotType(slotKey) { return String(slotKey || "").replace(/\d+$/, ""); }
function isActiveSlot(slotKey) {
  const t = slotType(slotKey);
  return t !== "BN" && t !== "IL" && t !== "";
}

// The date FAAB claims placed right now would process on (runs ~3am ET).
function claimProcessDate() {
  const etHour = +new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date());
  return etHour < 3 ? etDate() : addDays(etDate(), 1);
}
