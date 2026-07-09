/*
 * MLB Stats API adapter — the ONLY module that touches statsapi.mlb.com.
 * The API is free and unofficial; fields occasionally shift, so parsing here
 * is defensive and raw payload subsets are preserved in Firestore statlines
 * (points can be recomputed later if a parse bug is found).
 */
const BASE = "https://statsapi.mlb.com/api/v1";
const BASE11 = "https://statsapi.mlb.com/api/v1.1";

export async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- schedule ---------------------------------------------------------------
// Games for one ET date: [{gamePk, status, firstPitchUTC, homeId, awayId, doubleHeader}]
export async function scheduleForDate(dateISO) {
  const d = await fetchJson(`${BASE}/schedule?sportId=1&date=${dateISO}`);
  const days = d.dates || [];
  const games = [];
  days.forEach((day) => (day.games || []).forEach((g) => {
    games.push({
      gamePk: g.gamePk,
      firstPitchUTC: g.gameDate,                       // ISO UTC
      status: (g.status && g.status.abstractGameState) || "Preview", // Preview|Live|Final
      detailedState: (g.status && g.status.detailedState) || "",
      homeId: g.teams?.home?.team?.id,
      awayId: g.teams?.away?.team?.id,
      doubleHeader: g.doubleHeader || "N",
    });
  }));
  return games;
}

export async function seasonInfo(season) {
  const d = await fetchJson(`${BASE}/seasons/${season}?sportId=1`);
  return (d.seasons || [])[0] || null;
}

// ---- boxscores → stat lines --------------------------------------------------
export async function boxscore(gamePk) {
  return fetchJson(`${BASE}/game/${gamePk}/boxscore`);
}

// Also grab the live-feed decisions (W/L/SV) as a backstop when the boxscore
// pitching line lacks explicit win/save flags.
export async function gameDecisions(gamePk) {
  try {
    const d = await fetchJson(`${BASE11}/game/${gamePk}/feed/live?fields=liveData,decisions,winner,loser,save,id`);
    const dec = d?.liveData?.decisions || {};
    return {
      winner: dec.winner?.id || null,
      save: dec.save?.id || null,
    };
  } catch (e) {
    return { winner: null, save: null };
  }
}

const num = (v) => (Number.isFinite(+v) ? +v : 0);

// Run an async fn over items with a concurrency cap (order preserved).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// One game's boxscore → { [mlbId]: { name, teamId, batting, pitching, fieldPositions[] } }
// batting/pitching keep exactly the fields shared/scoring.js consumes.
export function extractStatLines(box, decisions = {}) {
  const out = {};
  ["home", "away"].forEach((side) => {
    const team = box?.teams?.[side];
    if (!team) return;
    const teamId = team.team?.id;
    Object.values(team.players || {}).forEach((pl) => {
      const id = pl.person?.id;
      if (!id) return;
      const b = pl.stats?.batting;
      const p = pl.stats?.pitching;
      const line = { name: pl.person.fullName || "", teamId, fieldPositions: [] };

      (pl.allPositions || []).forEach((pos) => {
        if (pos && pos.abbreviation) line.fieldPositions.push(pos.abbreviation);
      });

      if (b && Object.keys(b).length && num(b.plateAppearances) + num(b.gamesPlayed) > 0) {
        line.batting = {
          hits: num(b.hits), doubles: num(b.doubles), triples: num(b.triples),
          homeRuns: num(b.homeRuns), baseOnBalls: num(b.baseOnBalls),
          intentionalWalks: num(b.intentionalWalks), runs: num(b.runs),
          rbi: num(b.rbi), stolenBases: num(b.stolenBases), strikeOuts: num(b.strikeOuts),
          plateAppearances: num(b.plateAppearances),
        };
      }
      if (p && Object.keys(p).length && (num(p.outs) > 0 || p.inningsPitched || num(p.battersFaced) > 0)) {
        line.pitching = {
          // Always a number (0 for a pitcher pulled without an out) — an
          // `undefined` here makes Firestore reject the whole statline batch.
          outs: num(p.outs),
          inningsPitched: p.inningsPitched || "0.0",
          strikeOuts: num(p.strikeOuts), hits: num(p.hits),
          earnedRuns: num(p.earnedRuns), baseOnBalls: num(p.baseOnBalls),
          gamesStarted: num(p.gamesStarted),
          completeGames: num(p.completeGames), shutouts: num(p.shutouts),
          // Per-game W/SV/HLD flags appear directly on modern boxscores;
          // fall back to the live-feed decisions when missing.
          wins: num(p.wins) || (decisions.winner === id ? 1 : 0),
          saves: num(p.saves) || (decisions.save === id ? 1 : 0),
          holds: num(p.holds),
          battersFaced: num(p.battersFaced),
        };
      }
      if (line.batting || line.pitching) out[id] = line;
    });
  });
  return out;
}

// ---- teams & rosters ----------------------------------------------------------
export async function allTeams(season) {
  const d = await fetchJson(`${BASE}/teams?sportId=1&season=${season}`);
  return d.teams || [];
}

// 40-man roster with player status (IL detection). Status codes starting with
// "D" (D7/D10/D15/D60) are injured lists; "SU" suspended.
export async function roster40(teamId, season) {
  const d = await fetchJson(`${BASE}/teams/${teamId}/roster?rosterType=40Man&season=${season}`);
  return (d.roster || []).map((r) => ({
    mlbId: r.person?.id,
    name: r.person?.fullName || "",
    position: r.position?.abbreviation || "",
    statusCode: r.status?.code || "A",
    statusDescription: r.status?.description || "",
  }));
}

export function ilStatusFromCode(code) {
  if (!code) return null;
  const m = String(code).toUpperCase().match(/^D(\d+)?/); // D7/D10/D15/D60 = injured lists
  if (!m) return null;
  return m[1] ? `IL${m[1]}` : "IL";
}

// Full season hitting + pitching stat lines for a batch of players, for
// season-to-date fantasy scoring. Returns { [personId]: { hitting, pitching } }
// where each is the summed season stat object (or null). A traded player can
// come back as multiple splits, so counting stats are summed and outs are
// recomputed from each split's innings.
export async function seasonScoringStats(personIds, season) {
  const out = {};
  const ids = [...new Set(personIds.map((x) => (String(x).match(/^\d+/) || [])[0]).filter(Boolean))];
  const ipOuts = (st) =>
    Number.isFinite(+st.outs) ? +st.outs
      : (() => { const q = String(st.inningsPitched || "0.0").split("."); return num(q[0]) * 3 + num(q[1]); })();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40).join(","));
  // Fetch batches concurrently (capped) — sequential calls for ~1,300 players
  // would blow the function's time budget.
  const results = await mapLimit(chunks, 8, (chunk) => fetchJson(
    `${BASE}/people?personIds=${chunk}&hydrate=stats(group=[hitting,pitching],type=[season],season=${season})`));
  results.forEach((d) => {
    ((d && d.people) || []).forEach((p) => {
      const rec = { hitting: null, pitching: null };
      (p.stats || []).forEach((s) => {
        const group = s.group?.displayName;
        if (group !== "hitting" && group !== "pitching") return;
        const splits = (s.splits || []).filter((sp) => !sp.sport || sp.sport.id === 1);
        if (!splits.length) return;
        const agg = {}; let outs = 0;
        splits.forEach((sp) => {
          const st = sp.stat || {};
          Object.entries(st).forEach(([k, v]) => { if (typeof v === "number") agg[k] = (agg[k] || 0) + v; });
          outs += ipOuts(st);
        });
        if (group === "pitching") agg.outs = outs;
        rec[group] = agg;
      });
      out[p.id] = rec;
    });
  });
  return out;
}

// Season fielding/pitching splits for a batch of players (eligibility seeding).
export async function seasonStats(personIds, season) {
  const out = {};
  for (let i = 0; i < personIds.length; i += 40) {
    const ids = personIds.slice(i, i + 40).join(",");
    const d = await fetchJson(
      `${BASE}/people?personIds=${ids}&hydrate=stats(group=[fielding,pitching],type=[season],season=${season})`
    );
    (d.people || []).forEach((p) => {
      const rec = { fielding: {}, pitching: null };
      (p.stats || []).forEach((s) => {
        const group = s.group?.displayName;
        (s.splits || []).forEach((sp) => {
          if (group === "fielding") {
            const pos = sp.position?.abbreviation;
            if (pos) rec.fielding[pos] = (rec.fielding[pos] || 0) + num(sp.stat?.games);
          } else if (group === "pitching") {
            rec.pitching = {
              games: num(sp.stat?.gamesPlayed),
              gamesStarted: num(sp.stat?.gamesStarted),
            };
          }
        });
      });
      out[p.id] = { name: p.fullName, primary: p.primaryPosition?.abbreviation || "", ...rec };
    });
  }
  return out;
}
