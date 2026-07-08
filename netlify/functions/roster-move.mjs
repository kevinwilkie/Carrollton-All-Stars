/*
 * roster-move — on-demand HTTP endpoint for instant roster moves.
 * Currently one action: "drop" (cut a player to a free agent immediately).
 * Adds still go through daily FAAB (js/api.js placeClaim → waivers.mjs).
 *
 * Security: the caller proves identity with their Firebase ID token; the server
 * resolves their team from teams/{id}.ownerEmails and will only drop a player
 * that is actually on that team. Roster writes are otherwise function-only, so
 * this is the sanctioned path for an owner to change their own roster.
 */
import { db, leagueRef, admin, initAdmin } from "./lib/firebase.mjs";
import { etDate } from "./lib/league.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Pure: which team does this verified email control? (Case-insensitive match
// against seeded ownerEmails.) Exported for unit testing.
export function resolveTeam(teamsById, email) {
  const e = String(email || "").toLowerCase();
  return Object.keys(teamsById).find((id) =>
    (teamsById[id].ownerEmails || []).some((x) => String(x).toLowerCase() === e)) || null;
}

// Pure: the roster key for a given fantasy id (roster players are keyed by id,
// but be tolerant of a mismatched key vs. stored mlbId). Exported for testing.
export function rosterKeyFor(rosterPlayers, mlbId) {
  return Object.keys(rosterPlayers || {}).find(
    (k) => String(rosterPlayers[k].mlbId || k) === String(mlbId)) || null;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const { idToken, action, mlbId } = body || {};
  if (action !== "drop" || !mlbId) return json({ error: "Unsupported action" }, 400);

  initAdmin();
  let email;
  try {
    const decoded = await admin.auth().verifyIdToken(String(idToken || ""));
    if (!decoded.email_verified) return json({ error: "Your email isn't verified." }, 403);
    email = decoded.email;
  } catch (e) {
    return json({ error: "Invalid or expired sign-in — please sign in again." }, 401);
  }

  const L = leagueRef();
  const teamsSnap = await L.collection("teams").get();
  const teamsById = {};
  teamsSnap.forEach((d) => { teamsById[d.id] = d.data(); });

  const teamId = resolveTeam(teamsById, email);
  if (!teamId) return json({ error: "Your account isn't linked to a team." }, 403);

  const rref = L.collection("rosters").doc(teamId);
  const roster = (await rref.get()).data() || { players: {} };
  roster.players = roster.players || {};
  const key = rosterKeyFor(roster.players, mlbId);
  if (!key) return json({ error: "That player isn't on your roster." }, 404);

  const now = new Date().toISOString();
  const player = roster.players[key];
  delete roster.players[key];

  const batch = db().batch();
  batch.set(rref, { players: roster.players, updatedAt: now }, { merge: true });
  batch.set(L.collection("players").doc(String(mlbId)), { rosteredBy: null }, { merge: true });

  // Free the slot in today's lineup so it isn't left as a phantom starter.
  const lref = L.collection("lineups").doc(`${teamId}_${etDate()}`);
  const lsnap = await lref.get();
  if (lsnap.exists) {
    const slots = lsnap.data().slots || {};
    let changed = false;
    const next = {};
    for (const [slot, pid] of Object.entries(slots)) {
      if (pid && String(pid) === String(mlbId)) { next[slot] = null; changed = true; }
      else next[slot] = pid;
    }
    if (changed) batch.set(lref, { slots: next }, { merge: true });
  }

  batch.set(L.collection("transactions").doc(), {
    type: "drop", teamId, mlbId: String(mlbId), name: player.name || "", via: "roster", at: now,
  });
  await batch.commit();
  return json({ ok: true, teamId, name: player.name || "" });
};
