/*
 * Carrollton All-Stars — Firebase web configuration
 * ---------------------------------------------------------------------------
 * Paste your Firebase project's web-app config below (SETUP.md §3). While
 * FIREBASE_CONFIG stays null the apps run in local-only mode: the draft board
 * saves to the browser and the season app shows a setup notice.
 *
 * These values are PUBLIC by design (they ship to every browser) — security
 * comes from the database rules + Google sign-in, never from hiding keys.
 */
const FIREBASE_CONFIG = null;
/* Example:
const FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "carrollton-allstars.firebaseapp.com",
  databaseURL: "https://carrollton-allstars-default-rtdb.firebaseio.com",
  projectId: "carrollton-allstars",
  storageBucket: "carrollton-allstars.firebasestorage.app",
  messagingSenderId: "…",
  appId: "…",
};
*/

// Initialize the compat SDK once per page. Returns null when Firebase isn't
// configured or the CDN scripts didn't load (offline) — callers fall back to
// local mode, same behavior as League of Dreams.
function initFirebaseApp() {
  if (!FIREBASE_CONFIG || typeof firebase === "undefined" || !firebase.initializeApp) return null;
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    return firebase.app();
  } catch (e) {
    return null;
  }
}
