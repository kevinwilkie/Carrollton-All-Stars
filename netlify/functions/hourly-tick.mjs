/*
 * hourly-tick — five past every hour.
 * Executes trades whose 1-day review has ended with fewer than 6 vetoes,
 * and expires malformed/stale waiver claims.
 */
import { processTrades } from "./lib/trades.mjs";
import { expireStaleClaims } from "./lib/waivers.mjs";
import { etDate } from "./lib/league.mjs";
import { notify, failuresIn } from "./lib/alert.mjs";

export default async () => {
  const out = {};
  try { out.trades = await processTrades(); }
  catch (e) { console.error("trades failed:", e); out.trades = { error: String(e && e.message || e) }; }
  try { out.expiredClaims = await expireStaleClaims(etDate()); }
  catch (e) { out.expiredClaims = { error: String(e && e.message || e) }; }

  const fails = failuresIn(out);
  if (fails.length) await notify(`⚠️ hourly-tick: ${fails.join(" · ")}`);

  console.log("hourly-tick:", JSON.stringify(out));
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};
