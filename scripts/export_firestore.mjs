#!/usr/bin/env node
/*
 * Manual Firestore backup — dumps every leagues/carrollton collection to a
 * timestamped JSON file under backups/. The free Firebase (Spark) tier has no
 * scheduled export, so run this before draft night and periodically in-season:
 *
 *   FIREBASE_SERVICE_ACCOUNT_B64=... node scripts/export_firestore.mjs
 *
 * (Same service-account env var as the Netlify functions — see SETUP.md §6.)
 * Backups contain owner emails and league data, so backups/ is gitignored.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { leagueRef, initAdmin } from "../netlify/functions/lib/firebase.mjs";

async function main() {
  initAdmin();
  const L = leagueRef();
  const cols = await L.listCollections();
  if (!cols.length) { console.error("No collections found — is the league seeded?"); process.exit(1); }

  const dump = {};
  let total = 0;
  for (const col of cols) {
    const snap = await col.get();
    dump[col.id] = {};
    snap.forEach((d) => { dump[col.id][d.id] = d.data(); });
    total += snap.size;
    console.log(`  ${col.id}: ${snap.size} docs`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("backups", { recursive: true });
  const out = `backups/carrollton-${stamp}.json`;
  writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`\n✓ ${total} docs across ${cols.length} collections → ${out}`);
}

main().catch((e) => { console.error("Backup failed:", e && e.message || e); process.exit(1); });
