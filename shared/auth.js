/*
 * Carrollton All-Stars — Google sign-in + role resolution.
 * Requires: firebase compat SDK (app + auth), shared/firebase-init.js,
 * shared/league-config.js. House pattern from League of Dreams' setupAuth
 * plus Frankford's sign-in gate.
 *
 * Roles:
 *   "local"   — Firebase not configured (dev/offline)
 *   "guest"   — not signed in (or signed in with an unknown account)
 *   "owner"   — email matches a LEAGUE_TEAMS entry (Auth.teamId is set)
 *   "commish" — email is in COMMISH_EMAILS (commissioner may also own a team)
 */
"use strict";

const Auth = {
  role: "local",
  user: null,
  teamId: null,      // the team this owner controls (commish may have one too)
  _auth: null,
  _listeners: [],
};

function authTeamFor(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const t = LEAGUE_TEAMS.find((t) => String(t.email).toLowerCase() === e);
  return t ? t.id : null;
}
function authIsCommish(email) {
  return !!email && COMMISH_EMAILS.some((c) => c.toLowerCase() === String(email).toLowerCase());
}

// cb(role, user, teamId) — fired now and on every auth change.
function onAuthRole(cb) {
  Auth._listeners.push(cb);
  cb(Auth.role, Auth.user, Auth.teamId);
}
function _emitAuth() {
  Auth._listeners.forEach((cb) => cb(Auth.role, Auth.user, Auth.teamId));
}

function initAuth() {
  const app = initFirebaseApp();
  if (!app || !firebase.auth) { Auth.role = "local"; _emitAuth(); return; }
  Auth._auth = firebase.auth();
  Auth._auth.getRedirectResult().catch(() => {}); // finish a pending redirect sign-in
  Auth._auth.onAuthStateChanged((user) => {
    Auth.user = user || null;
    const email = user && user.email;
    Auth.teamId = authTeamFor(email);
    Auth.role = authIsCommish(email) ? "commish" : Auth.teamId ? "owner" : "guest";
    _emitAuth();
  });
}

function signInGoogle() {
  if (!Auth._auth) return toast("Sign-in isn't available (Firebase not configured).", "error");
  const provider = new firebase.auth.GoogleAuthProvider();
  Auth._auth.signInWithPopup(provider).catch((e) => {
    const code = e && e.code;
    if (code === "auth/popup-blocked" || code === "auth/cancelled-popup-request" ||
        code === "auth/operation-not-supported-in-this-environment") {
      Auth._auth.signInWithRedirect(provider).catch(() => {});
    } else if (code !== "auth/popup-closed-by-user") {
      toast("Sign-in failed: " + (e && e.message ? e.message : code || "unknown"), "error");
    }
  });
}

function signOutUser() {
  if (Auth._auth) Auth._auth.signOut().catch(() => {});
}
