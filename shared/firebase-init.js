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
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAjcFDbjg9nbHoUhS3DF_dE5UXfkPgbMKU",
  authDomain: "carrollton-all-stars.firebaseapp.com",
  databaseURL: "https://carrollton-all-stars-default-rtdb.firebaseio.com",
  projectId: "carrollton-all-stars",
  storageBucket: "carrollton-all-stars.firebasestorage.app",
  messagingSenderId: "140901323118",
  appId: "1:140901323118:web:39f3908644d322841e717f",
};

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
