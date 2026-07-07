#!/usr/bin/env node
/*
 * Backfill scoring for past dates — used when the system starts mid-week
 * (score the current week's elapsed days) or after an ingest outage.
 * Creates the day's lineups if missing (from each roster), then runs the
 * exact same pipeline as the scheduled ingest: schedule → locks → box
 * scores → points → matchup totals.
 *
 *   node scripts/backfill_days.mjs --from 2026-07-06 --to 2026-07-07
 *
 * Needs FIREBASE_SERVICE_ACCOUNT_B64 (same as the functions). Lineups for
 * past days are built from current rosters — Yahoo's actual day-by-day
 * lineups aren't recoverable, so points will differ slightly from Yahoo.
 */
import { ensureLineups } from "../netlify/functions/lib/lineups.mjs";
import { ingestDate } from "../netlify/functions/lib/ingest.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const FROM = arg("from");
const TO = arg("to", FROM);
if (!FROM) { console.error("usage: backfill_days.mjs --from YYYY-MM-DD [--to YYYY-MM-DD]"); process.exit(1); }

const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

for (let date = FROM; date <= TO; date = addDays(date, 1)) {
  const created = await ensureLineups(date);
  const out = await ingestDate(date);
  console.log(`${date}: lineups created ${created}, games ${out.games}, statlines ${out.statlines}`);
}
console.log("✓ backfill complete");
