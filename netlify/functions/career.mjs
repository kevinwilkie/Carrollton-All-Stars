/*
 * career — on-demand HTTP endpoint for a player's season-by-season career stats.
 * GET /.netlify/functions/career?id=<mlbPersonId>&group=hitting|pitching
 *
 * The MLB Stats API doesn't reliably send CORS headers, so the browser can't
 * hit it directly — this proxies the yearByYear stats server-side and computes
 * fantasy points per season with the shared scoring engine (single source of
 * truth). Public read-only data, so no auth needed.
 *
 * Fantasy points: hitters are exact from season totals; pitchers reuse the
 * engine for everything except quality starts (which can't be derived from a
 * season aggregate) and add QS × weight from the season's `qualityStarts` count
 * when the API provides it. The current season is shown exactly by the caller
 * (our own scored statlines), which overrides the estimate for that row.
 */
import { fetchJson } from "./lib/mlb.mjs";
import { etDate } from "./lib/league.mjs";
import { outsOf, seasonFantasyPoints } from "./lib/season-score.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=900" },
  });

const num = (v) => (Number.isFinite(+v) ? +v : 0);

// Counting fields we sum across a season's team-splits, per group.
const HIT_FIELDS = ["gamesPlayed", "plateAppearances", "atBats", "runs", "hits",
  "doubles", "triples", "homeRuns", "rbi", "baseOnBalls", "intentionalWalks",
  "stolenBases", "strikeOuts"];
const PIT_FIELDS = ["gamesPlayed", "gamesStarted", "wins", "losses", "saves",
  "holds", "hits", "earnedRuns", "baseOnBalls", "strikeOuts", "completeGames",
  "shutouts", "qualityStarts"];

function emptySum(fields) {
  const o = {}; fields.forEach((f) => (o[f] = 0)); return o;
}
function addInto(acc, stat, fields, pitching) {
  fields.forEach((f) => (acc[f] += num(stat[f])));
  if (pitching) acc.outs = (acc.outs || 0) + outsOf(stat);
}

// Pure: MLB yearByYear payload → per-season rows (newest first) + career total.
// Exported for unit testing (no network).
export function careerFromStats(api, group, currentSeason) {
  const pitching = group === "pitching";
  const fields = pitching ? PIT_FIELDS : HIT_FIELDS;
  const block = ((api && api.stats) || []).find(
    (s) => (s.type?.displayName === "yearByYear") &&
      (!s.group || s.group.displayName === group));
  const splits = (block && block.splits) || [];

  // Group team-splits by season (a traded player has one split per team).
  const bySeason = {};
  splits.forEach((sp) => {
    const yr = String(sp.season || "");
    if (!yr) return;
    const row = bySeason[yr] || (bySeason[yr] = { season: yr, teams: [], sum: emptySum(fields) });
    if (pitching) row.sum.outs = row.sum.outs || 0;
    addInto(row.sum, sp.stat || {}, fields, pitching);
    // yearByYear splits carry team.id (+ name); abbreviation isn't included, so
    // keep both — the client resolves an id to an abbr via its TEAMS map.
    if (sp.team && (sp.team.id != null || sp.team.abbreviation)) {
      row.teams.push({ id: sp.team.id != null ? sp.team.id : null, abbr: sp.team.abbreviation || null });
    }
  });

  const rows = Object.values(bySeason)
    .map((r) => {
      const uniq = [...new Map(r.teams.map((t) => [t.id != null ? t.id : t.abbr, t])).values()];
      return {
        season: r.season,
        // display string when we can build one server-side; else null + teamId
        // so the client maps the id to an abbreviation.
        team: uniq.length > 1 ? uniq.length + "TM" : (uniq.length === 1 ? (uniq[0].abbr || null) : "—"),
        teamId: uniq.length === 1 ? uniq[0].id : null,
        numTeams: uniq.length,
        stat: r.sum,
        fp: seasonFantasyPoints(r.sum, pitching),
      };
    })
    .sort((a, b) => (a.season < b.season ? 1 : -1));

  const total = emptySum(fields);
  if (pitching) total.outs = 0;
  rows.forEach((r) => fields.forEach((f) => (total[f] += num(r.stat[f]))));
  if (pitching) rows.forEach((r) => (total.outs += num(r.stat.outs)));
  const career = { stat: total, fp: seasonFantasyPoints(total, pitching) };

  return { group, rows, career, season: currentSeason };
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  const url = new URL(req.url);
  const id = (String(url.searchParams.get("id") || "").match(/^\d+/) || [])[0];
  const group = url.searchParams.get("group") === "pitching" ? "pitching" : "hitting";
  if (!id) return json({ error: "id required" }, 400);

  const season = +etDate().slice(0, 4);
  try {
    const api = await fetchJson(
      `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=yearByYear&group=${group}`);
    const data = careerFromStats(api, group, season);
    return json({ ok: true, id, ...data });
  } catch (e) {
    return json({ error: "Couldn't load career stats." }, 502);
  }
};
