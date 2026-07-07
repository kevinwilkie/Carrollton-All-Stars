/*
 * Carrollton All-Stars — League Configuration
 * ---------------------------------------------------------------------------
 * THE single source of truth for league rules. Loaded three ways:
 *   - season app + draft board: plain <script src="shared/league-config.js">
 *     (each constant becomes a page global, LoD/Frankford house style)
 *   - Netlify functions + scripts/: `import cfg from "../shared/league-config.js"`
 *
 * Edit this file to change owners, budgets, roster shape, or scoring — then
 * redeploy. Rule changes mid-season affect scoring from the next ingest run.
 */
(function (root, factory) {
  const cfg = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = cfg;
  else Object.assign(root, cfg);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- League identity ------------------------------------------------------
  const LEAGUE = {
    id: "carrollton",          // Firestore namespace: leagues/carrollton/…
    name: "Carrollton All-Stars",
    season: 2027,              // bump each year (also bump SYNC_PATH in draft)
  };

  // ---- The 12 teams ----------------------------------------------------------
  // `emails` = the Google account(s) the owner may sign in with (any of them
  // maps to the team). TODO(kevin): fill in the 11 missing emails. Keep these
  // in sync with firestore.rules.
  const LEAGUE_TEAMS = [
    { id: "acuna-matata",   name: "Acuña Matata",                  owner: "Kevin Wilkie",    emails: ["kevin.wilkie@campusoutreach.org", "kevinwilkie92@gmail.com"] },
    { id: "rally-cats",     name: "Rally Cats",                    owner: "Katie Pollard",   emails: ["TODO-katie@example.com"] },
    { id: "speedster",      name: "kylespayde518's Speedster",     owner: "Kyle Spayde",     emails: ["TODO-kyle@example.com"] },
    { id: "jump",           name: "Might as well JUMP!",           owner: "Michael Bearden", emails: ["TODO-michael@example.com"] },
    { id: "hogans-heroes",  name: "Hogan's Heroes",                owner: "Ed Hogan",        emails: ["TODO-ed@example.com"] },
    { id: "witt-wisdom",    name: "Witt and Wisdom",               owner: "Anthony Amato",   emails: ["TODO-anthony@example.com"] },
    { id: "en-fuego",       name: "Coming En Fuego",               owner: "Curtis Gann",     emails: ["TODO-curtis@example.com"] },
    { id: "beer-snobs",     name: "Dream City Beer Snobs",         owner: "Joel Pollard",    emails: ["TODO-joel@example.com"] },
    { id: "ozzies-fish",    name: "Ozzie's Pet Fish",              owner: "Sam Pollard",     emails: ["TODO-sam@example.com"] },
    { id: "cousin-vinnie",  name: "My Cousin Vinnie",              owner: "Joe Ingui",       emails: ["TODO-joe@example.com"] },
    { id: "ace-dan",        name: "Ace Dan",                       owner: "Dan Moffitt",     emails: ["TODO-dan@example.com"] },
    { id: "baldwin-bro",    name: "Drake is the Best Baldwin Bro", owner: "Richie Valdes",   emails: ["TODO-richie@example.com"] },
  ];

  // Commissioner Google account(s). Must match database.rules.json (RTDB) and
  // firestore.rules — all three gate on the same email(s).
  const COMMISH_EMAILS = ["kevin.wilkie@campusoutreach.org", "kevinwilkie92@gmail.com"];

  // ---- Draft -----------------------------------------------------------------
  const BUDGET = 300;        // auction dollars per team
  const ROSTER_SIZE = 26;    // slots filled at the draft (IL slots excluded)

  // ---- Roster construction ---------------------------------------------------
  // Active lineup (20) + bench (6) = the 26 draftable slots; 4 IL on top.
  const LINEUP_SLOTS = [
    "C", "1B", "2B", "3B", "SS", "INF",
    "OF", "OF", "OF", "OF",
    "UTIL", "UTIL",
    "SP", "SP", "SP", "SP",
    "RP", "RP", "RP", "RP",
  ];
  const BENCH_SLOTS = 6;
  const IL_SLOTS = 4;

  // Which player positions may fill each slot type. "positions" on a player is
  // an array like ["2B","SS"] (see eligibility rules below). DH-only players
  // (e.g. a two-way player's bat) carry "DH" and fit UTIL/BN.
  const HITTER_POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "DH"];
  const SLOT_ELIGIBILITY = {
    C:    ["C"],
    "1B": ["1B"],
    "2B": ["2B"],
    "3B": ["3B"],
    SS:   ["SS"],
    INF:  ["1B", "2B", "3B", "SS"],
    OF:   ["OF"],
    UTIL: HITTER_POSITIONS,
    SP:   ["SP"],
    RP:   ["RP"],
    BN:   HITTER_POSITIONS.concat(["SP", "RP"]),
    IL:   HITTER_POSITIONS.concat(["SP", "RP"]), // plus: player must actually be on an MLB IL
  };

  // Position eligibility (Yahoo style). Season START = positions earned LAST
  // season; during the season a player can only ADD eligibility (5+ games at a
  // new spot), never lose what he started with. Next season recomputes from
  // this season alone — e.g. 5 relief outings last year grant RP all of this
  // year, gone next year if he never relieves again.
  const ELIGIBILITY = { lastSeasonGames: 10, thisSeasonGames: 5, spStarts: 3, rpRelief: 5 };

  // ---- Scoring ---------------------------------------------------------------
  // NOTE on walks: MLB counts intentional walks inside BB, and this league
  // scores Walks=1 AND Intentional Walks=1 — so an IBB is worth 2 total
  // (1 as a walk + 1 bonus). That is intentional.
  const SCORING = {
    hitting: {
      "1B": 1, "2B": 2, "3B": 3, HR: 4,
      BB: 1, IBB: 1, R: 1, RBI: 1, SB: 2, SO: -1,
    },
    pitching: {
      OUT: 1,          // Innings Pitched = 3/inning ⇒ 1 per out (6.2 IP = 20)
      SO: 1, W: 2, QS: 5, SV: 5, HLD: 2, CG: 3, SHO: 3,
      ER: -2, H: -1, BB: -1,
    },
    qualityStart: { minOuts: 18, maxEarnedRuns: 3 }, // 6+ IP and ≤3 ER
  };

  // ---- Season structure ------------------------------------------------------
  const SEASON_STRUCTURE = {
    regularWeeks: 21,      // balanced round-robin (10 opponents ×2, 1 ×1)
    playoffTeams: 6,       // top 6; seeds 1–2 get a first-round bye
    playoffWeeks: 3,       // quarters → semis → championship (+ 3rd-place game)
  };

  // ---- Transactions ----------------------------------------------------------
  const FAAB = {
    budget: 100,           // per team per season
    minBid: 1,
    // Daily processing order: highest bid wins; ties go to the WORSE record
    // (win% then fewer points-for), then coin flip.
  };
  const TRADE = {
    reviewHours: 24,       // executes after this unless vetoed
    vetoesNeeded: 6,       // majority of the 10 non-involved owners
  };

  // ---- Two-way players (Yahoo-style split) ------------------------------------
  // These MLB person ids exist as TWO separate fantasy players: "{id}:B"
  // (batter — hitter positions, scores only batting) and "{id}:P" (pitcher —
  // SP/RP, scores only pitching). Different teams may own each half.
  const TWO_WAY_PLAYERS = [
    660271, // Shohei Ohtani
  ];

  // ---- Keepers ---------------------------------------------------------------
  const KEEPER = {
    max: 5,                // per team
    y1Inflation: 5,        // Year 1 price = last auction price + $5
    undraftedPrice: 5,     // flat $5 for waiver/FA pickups
    // Year 2 price = ESPN live draft trend AVG SALARY (rounded, $1 min),
    // frozen at the deadline below. No player may be kept a 3rd straight year.
    espnDeadline: "2027-03-14", // YYYY-MM-DD ~1 week before the draft; update yearly
  };

  return {
    LEAGUE, LEAGUE_TEAMS, COMMISH_EMAILS,
    BUDGET, ROSTER_SIZE, LINEUP_SLOTS, BENCH_SLOTS, IL_SLOTS,
    HITTER_POSITIONS, SLOT_ELIGIBILITY, ELIGIBILITY,
    SCORING, SEASON_STRUCTURE, FAAB, TRADE, KEEPER, TWO_WAY_PLAYERS,
  };
});
