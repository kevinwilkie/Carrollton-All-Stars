/*
 * Trade execution (hourly-tick). A trade proposal that the receiving team
 * ACCEPTED enters its 1-day league review; when reviewEndsAt passes with
 * fewer than 6 vetoes (majority of the 10 uninvolved owners), the rosters
 * swap. The commissioner can force/veto from the Admin tab at any time.
 */
import { db, leagueRef } from "./firebase.mjs";
import { CFG } from "./league.mjs";

export async function processTrades() {
  const L = leagueRef();
  const now = new Date().toISOString();
  const snap = await L.collection("trades").where("status", "==", "accepted").get();
  let executed = 0, vetoed = 0;

  for (const d of snap.docs) {
    const t = d.data();
    if (!t.reviewEndsAt || t.reviewEndsAt > now) continue;

    const vetoes = Object.values(t.vetoes || {}).filter(Boolean).length;
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

  const batch = db().batch();
  const log = (entry) => batch.set(L.collection("transactions").doc(), { ...entry, at: now });

  gives.forEach((id) => {
    const p = from.players[id];
    delete from.players[id];
    to.players[id] = { ...p, via: "trade" };
    batch.set(L.collection("players").doc(id), { rosteredBy: t.to }, { merge: true });
    log({ type: "trade", mlbId: id, name: p.name || "", fromTeam: t.from, toTeam: t.to });
  });
  gets.forEach((id) => {
    const p = to.players[id];
    delete to.players[id];
    from.players[id] = { ...p, via: "trade" };
    batch.set(L.collection("players").doc(id), { rosteredBy: t.from }, { merge: true });
    log({ type: "trade", mlbId: id, name: p.name || "", fromTeam: t.to, toTeam: t.from });
  });

  batch.set(fromRef, { players: from.players, updatedAt: now }, { merge: true });
  batch.set(toRef, { players: to.players, updatedAt: now }, { merge: true });
  await batch.commit();
  return { ok: true };
}
