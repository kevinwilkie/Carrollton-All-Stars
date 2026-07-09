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
import { CFG, etDate } from "./lib/league.mjs";
import Scoring from "../../shared/scoring.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=900" },
  });

const num = (v) => (Number.isFinite(+v) ? +v : 0);
function ipToOuts(ip) {
  const s = String(ip == null ? "" : ip).split(".");
  return num(s[0]) * 3 + num(s[1]);
}
const outsOf = (stat) =>
  Number.isFinite(+stat.outs) ? +stat.outs : ipToOuts(stat.inningsPitched);

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

function fantasyPoints(sum, pitching) {
  if (!pitching) return Scoring.round1(Scoring.scoreHitting(sum));
  // Reuse the engine for every pitching component except QS (a season aggregate
  // would spuriously read as one giant "start"); zero gamesStarted disables the
  // engine's per-game QS, then add the real season quality-start bonus.
  const qsWeight = (CFG.SCORING && CFG.SCORING.pitching && CFG.SCORING.pitching.QS) || 5;
  const base = Scoring.scorePitching({ ...sum, gamesStarted: 0 });
  return Scoring.round1(base + num(sum.qualityStarts) * qsWeight);
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
    if (sp.team && sp.team.abbreviation) row.teams.push(sp.team.abbreviation);
  });

  const rows = Object.values(bySeason)
    .map((r) => ({
      season: r.season,
      team: r.teams.length === 1 ? r.teams[0] : (r.teams.length ? r.teams.length + "TM" : "—"),
      numTeams: r.teams.length,
      stat: r.sum,
      fp: fantasyPoints(r.sum, pitching),
    }))
    .sort((a, b) => (a.season < b.season ? 1 : -1));

  const total = emptySum(fields);
  if (pitching) total.outs = 0;
  rows.forEach((r) => fields.forEach((f) => (total[f] += num(r.stat[f]))));
  if (pitching) rows.forEach((r) => (total.outs += num(r.stat.outs)));
  const career = { stat: total, fp: fantasyPoints(total, pitching) };

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
