/*
 * ingest-stats — every 30 minutes (netlify.toml).
 * Pulls MLB box scores for the current fantasy day (plus the previous day
 * shortly after midnight ET for late West Coast finishes), snapshots lineup
 * locks for games that have started, refreshes statlines/points, and updates
 * the live week scores + matchups. No-ops instantly with no games scheduled.
 */
import { ingestDate } from "./lib/ingest.mjs";
import { etDate, addDays } from "./lib/league.mjs";

export default async () => {
  const today = etDate();
  const dates = [today];
  // Until ~6am ET, yesterday's late games may still be finishing/finalizing.
  const etHour = +new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date());
  if (etHour < 6) dates.unshift(addDays(today, -1));

  const results = [];
  for (const date of dates) {
    try {
      results.push(await ingestDate(date));
    } catch (e) {
      console.error(`ingest failed for ${date}:`, e);
      results.push({ date, error: String(e && e.message || e) });
    }
  }
  console.log("ingest-stats:", JSON.stringify(results));
  return new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } });
};
