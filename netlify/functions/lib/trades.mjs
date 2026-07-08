/*
 * Trade execution (hourly-tick). A trade proposal that the receiving team
 * ACCEPTED enters its 1-day league review; when reviewEndsAt passes with
 * fewer than 6 vetoes (majority of the 10 uninvolved owners), the rosters
 * swap. The commissioner can force/veto from the Admin tab at any time.
 */
import { db, leagueRef, admin } from "./firebase.mjs";
import { CFG, etDate } from "./league.mjs";

export async function processTrades() {
  const L = leagueRef();
  const now = new Date().toISOString();
  const snap = await L.collection("trades").where("status", "==", "accepted").get();
  let executed = 0, vetoed = 0;

  for (const d of snap.docs) {
    const t = d.data();
    // Server-authoritative review window: stamp the deadline the first tick we
    // see the trade accepted, then defer. A colluding recipient can set any
    // reviewEndsAt on the client, so we must NOT trust it — otherwise a past
    // value would let the trade skip the league's veto period entirely.
    if (!t.serverReviewEndsAt) {
      const end = new Date(Date.parse(now) + CFG.TRADE.reviewHours * 3600e3).toISOString();
      await d.ref.set({ serverReviewEndsAt: end }, { merge: true });
      continue;
    }
    if (t.serverReviewEndsAt > now) continue;

    // Count only uninvolved owners' vetoes (the rules already bar the two
    // participants from writing one, but be defensive against stale data).
    const vetoes = Object.entries(t.vetoes || {})
      .filter(([team, v]) => v && team !== t.from && team !== t.to).length;
    if (vetoes >= CFG.TRADE.vetoesNeeded) {
      await d.ref.set({ status: "vetoed", resolvedAt: now, vetoCount: vetoes }, { merge: true });
      vetoed++;
      continue;
    }
    const result = await executeTrade(t);
    await d.ref.set({
      status: result.ok ? "executed" : "failed",
      resolvedAt: now, vetoCount: vetoes, resolvedNote: result.note || "",
    }, { merge: true });
    if (result.ok) executed++;
  }
  return { executed, vetoed };
}

export async function executeTrade(t) {
  const L = leagueRef();
  const now = new Date().toISOString();
  const fromRef = L.collection("rosters").doc(t.from);
  const toRef = L.collection("rosters").doc(t.to);
  const [fromSnap, toSnap] = await Promise.all([fromRef.get(), toRef.get()]);
  const from = fromSnap.data() || { players: {} };
  const to = toSnap.data() || { players: {} };
  from.players = from.players || {};
  to.players = to.players || {};

  const gives = (t.gives || []).map(String);
  const gets = (t.gets || []).map(String);
  for (const id of gives) if (!from.players[id]) return { ok: false, note: `Player ${id} no longer on ${t.from}.` };
  for (const id of gets) if (!to.players[id]) return { ok: false, note: `Player ${id} no longer on ${t.to}.` };

  // Uneven trades change roster sizes — neither side may end over the cap.
  const MAX = CFG.ROSTER_SIZE + CFG.IL_SLOTS;
  const fromAfter = Object.keys(from.players).length - gives.length + gets.length;
  const toAfter = Object.keys(to.players).length - gets.length + gives.length;
  if (fromAfter > MAX) return { ok: false, note: `${t.from} would exceed the ${MAX}-player roster limit.` };
  if (toAfter > MAX) return { ok: false, note: `${t.to} would exceed the ${MAX}-player roster limit.` };

  const batch = db().batch();
  const del = admin.firestore.FieldValue.delete();
  const path = (id) => new admin.firestore.FieldPath("players", id);
  const log = (entry) => batch.set(L.collection("transactions").doc(), { ...entry, at: now });

  // Write only the traded keys (per-field delete on the giver, per-field merge
  // on the receiver) rather than overwriting the whole `players` map. A
  // concurrent drop/waiver touching a DIFFERENT player on the same roster then
  // can't be clobbered by this trade (no whole-map lost update).
  gives.forEach((id) => {
    const p = from.players[id];
    delete from.players[id];
    to.players[id] = { ...p, via: "trade" };
    batch.update(fromRef, path(id), del);
    batch.set(toRef, { players: { [id]: { ...p, via: "trade" } } }, { merge: true });
    batch.set(L.collection("players").doc(id), { rosteredBy: t.to }, { merge: true });
    log({ type: "trade", mlbId: id, name: p.name || "", fromTeam: t.from, toTeam: t.to });
  });
  gets.forEach((id) => {
    const p = to.players[id];
    delete to.players[id];
    from.players[id] = { ...p, via: "trade" };
    batch.update(toRef, path(id), del);
    batch.set(fromRef, { players: { [id]: { ...p, via: "trade" } } }, { merge: true });
    batch.set(L.collection("players").doc(id), { rosteredBy: t.from }, { merge: true });
    log({ type: "trade", mlbId: id, name: p.name || "", fromTeam: t.to, toTeam: t.from });
  });

  batch.set(fromRef, { updatedAt: now }, { merge: true });
  batch.set(toRef, { updatedAt: now }, { merge: true });

  // Clear each side's departed players from TODAY's lineup so the losing team
  // isn't left with a phantom in an active slot. (Scoring reads the `locked`
  // map, not `slots`, so a player already locked from an earlier game keeps his
  // points — this only frees the open slot going forward.)
  const today = etDate();
  await clearFromLineup(L, batch, t.from, gives, today);
  await clearFromLineup(L, batch, t.to, gets, today);

  await batch.commit();
  return { ok: true };
}

async function clearFromLineup(L, batch, teamId, ids, date) {
  if (!ids.length) return;
  const lref = L.collection("lineups").doc(`${teamId}_${date}`);
  const lsnap = await lref.get();
  if (!lsnap.exists) return;
  const slots = lsnap.data().slots || {};
  const gone = new Set(ids.map(String));
  let changed = false;
  const next = {};
  for (const [slot, pid] of Object.entries(slots)) {
    if (pid && gone.has(String(pid))) { next[slot] = null; changed = true; }
    else next[slot] = pid;
  }
  if (changed) batch.set(lref, { slots: next }, { merge: true });
}
