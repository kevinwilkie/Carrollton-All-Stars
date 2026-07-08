/*
 * Firebase Admin bootstrap for the scheduled functions.
 * Credentials come from Netlify env vars (see SETUP.md §6):
 *   FIREBASE_SERVICE_ACCOUNT_B64 — base64 of the service-account JSON
 *   FIREBASE_DB_URL              — Realtime Database URL (draft archive access)
 */
import admin from "firebase-admin";

let inited = false;

export function initAdmin() {
  if (!inited) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 env var is not set (SETUP.md §6)");
    const cred = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    admin.initializeApp({
      credential: admin.credential.cert(cred),
      databaseURL: process.env.FIREBASE_DB_URL || undefined,
    });
    // Drop undefined fields instead of throwing on them — one stray value must
    // never abort an entire nightly ingest/rollover batch. Must be set once,
    // before any Firestore read/write.
    admin.firestore().settings({ ignoreUndefinedProperties: true });
    inited = true;
  }
  return admin;
}

export function db() {
  return initAdmin().firestore();
}

// leagues/carrollton — every season doc hangs off this.
export function leagueRef() {
  const { LEAGUE } = requireLeagueConfig();
  return db().collection("leagues").doc(LEAGUE.id);
}

import leagueConfig from "../../../shared/league-config.js";
export function requireLeagueConfig() {
  return leagueConfig;
}

export { admin };
