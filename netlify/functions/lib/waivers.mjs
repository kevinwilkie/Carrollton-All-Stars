/*
 * Daily FAAB waiver processing (~3am ET from daily-rollover).
 * Highest bid wins; ties go to the worse record (win% → points-for → flip).
 * Winning claims swap rosters, deduct FAAB, and append to the transaction log;
 * losing claims get a human-readable reason.
 */
import { db, leagueRef, admin } from "./firebase.mjs";
import { CFG, worseRecordFirst } from "./league.mjs";

const MAX_ROSTER = CFG.ROSTER_SIZE + CFG.IL_SLOTS; // 26 + 4 IL stashes

export async function processClaims(today) {
  const L = leagueRef();
  const claimsSnap = await L.collection("claims")
    .where("status", "==", "pending").get();
  const due = [];
  claimsSnap.forEach((d) => {
    const c = d.data();
    if ((c.forDate || today) <= today) due.push({ id: d.id, ...c });
  });
  if (!due.length) return { processed: 0 };

  const teamsSnap = await L.collection("teams").get();
  const teams = {};
  teamsSnap.forEach((d) => { teams[d.id] = { id: d.id, ...d.data() }; });
  const rosters = {};
  for (const t of CFG.LEAGUE_TEAMS) {
    rosters[t.id] = (await L.collection("rosters").doc(t.id).get()).data() || { players: {} };
    rosters[t.id].players = rosters[t.id].players || {};
  }
  const rosteredBy = {};
  Object.entries(rosters).forEach(([teamId, r]) =>
    Object.keys(r.players).forEach((pid) => { rosteredBy[pid] = teamId; }));

  // Highest bid first; ties by worse record.
  due.sort((a, b) =>
    (b.bid || 0) - (a.bid || 0) ||
    worseRecordFirst(teams[a.teamId] || {}, teams[b.teamId] || {}));

  // A single won claim emits up to ~7 writes (roster, team FAAB, player add +
  // drop, claim result, add/drop logs). Firestore caps a batch at 500 ops, so
  // on a busy waiver morning one giant batch would throw and roll back the
  // ENTIRE day. Accumulate ops and flush between claims (never mid-claim, so
  // each claim stays atomic) to stay under the cap.
  let batch = db().batch();
  let ops = 0;
  const now = new Date().toISOString();
  const setOp = (ref, data, opts) => { opts ? batch.set(ref, data, opts) : batch.set(ref, data); ops++; };
  const flush = async () => { if (ops) { await batch.commit(); batch = db().batch(); ops = 0; } };
  const log = (entry) =>
    setOp(L.collection("transactions").doc(), { ...entry, at: now });

  let processed = 0;
  for (const c of due) {
    if (ops >= 440) await flush();   // headroom for this claim's ~7 writes
    const ref = L.collection("claims").doc(c.id);
    const addId = String(c.add);
    const team = teams[c.teamId];
    const roster = rosters[c.teamId];
    const fail = (note) => setOp(ref, { status: "lost", resolvedNote: note, resolvedAt: now }, { merge: true });

    if (!team || !roster) { fail("Team not found."); continue; }
    if (rosteredBy[addId]) { fail(`Already claimed by ${teams[rosteredBy[addId]]?.name || "another team"}.`); continue; }
    if ((c.bid || 0) < CFG.FAAB.minBid) { fail(`Bid below the $${CFG.FAAB.minBid} minimum.`); continue; }
    if ((team.faabRemaining ?? CFG.FAAB.budget) < c.bid) { fail("Not enough FAAB left."); continue; }
    const dropId = c.drop ? String(c.drop) : null;
    if (dropId && !roster.players[dropId]) { fail("The player to drop is no longer on your roster."); continue; }
    if (!dropId && Object.keys(roster.players).length >= MAX_ROSTER) { fail("Roster full — a drop is required."); continue; }

    // Execute.
    if (dropId) {
      const dropped = roster.players[dropId];
      delete roster.players[dropId];
      delete rosteredBy[dropId];
      setOp(L.collection("players").doc(dropId), { rosteredBy: null }, { merge: true });
      log({ type: "drop", teamId: c.teamId, mlbId: dropId, name: dropped?.name || "", via: "waivers" });
    }
    roster.players[addId] = {
      mlbId: addId, name: c.addName || "", positions: c.addPositions || [],
      via: "faab", price: c.bid,
    };
    rosteredBy[addId] = c.teamId;
    team.faabRemaining = (team.faabRemaining ?? CFG.FAAB.budget) - c.bid;

    setOp(L.collection("rosters").doc(c.teamId), { players: roster.players, updatedAt: now }, { merge: true });
    setOp(L.collection("teams").doc(c.teamId), { faabRemaining: team.faabRemaining }, { merge: true });
    setOp(L.collection("players").doc(addId), { rosteredBy: c.teamId }, { merge: true });
    setOp(ref, { status: "won", resolvedNote: `Won for $${c.bid}.`, resolvedAt: now }, { merge: true });
    log({ type: "add", teamId: c.teamId, mlbId: addId, name: c.addName || "", via: "faab", bid: c.bid });
    processed++;
  }

  await flush();
  return { processed, considered: due.length };
}

// Claims left pending past their process date (e.g. malformed) expire quietly.
export async function expireStaleClaims(today) {
  const L = leagueRef();
  const snap = await L.collection("claims").where("status", "==", "pending").get();
  const now = new Date().toISOString();
  let batch = db().batch();
  let ops = 0, n = 0;
  for (const d of snap.docs) {
    const c = d.data();
    if ((c.forDate || today) < today) {
      batch.set(d.ref, { status: "expired", resolvedAt: now }, { merge: true });
      n++;
      if (++ops >= 450) { await batch.commit(); batch = db().batch(); ops = 0; }
    }
  }
  if (ops) await batch.commit();
  return n;
}
