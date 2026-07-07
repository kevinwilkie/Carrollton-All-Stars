/*
 * Week finalization: matchup results → records → standings/seeds → playoff
 * bracket advancement. Runs from daily-rollover the morning after a scoring
 * week ends. Playoffs: top 6, weeks 22–24; seeds 1–2 bye in week 22.
 */
import { db, leagueRef } from "./firebase.mjs";
import { CFG } from "./league.mjs";

export async function finalizeWeekIfEnded(yesterday) {
  const L = leagueRef();
  const settings = (await L.collection("config").doc("settings").get()).data() || {};
  const week = (settings.weeks || []).find((w) => w.end === yesterday);
  if (!week) return null;

  const muSnap = await L.collection("matchups").where("week", "==", week.n).get();
  const teamsSnap = await L.collection("teams").get();
  const teams = {};
  teamsSnap.forEach((d) => { teams[d.id] = d.data(); });

  const batch = db().batch();
  const winners = {}; // matchup label/index -> winner teamId (for playoff advancement)

  muSnap.forEach((d) => {
    const mu = d.data();
    if (mu.final || !mu.home || !mu.away) return;
    const tie = mu.homePts === mu.awayPts;
    const homeWon = mu.homePts > mu.awayPts;
    winners[mu.label || `m${mu.index}`] = tie ? null
      : homeWon ? mu.home : mu.away;
    const losers = tie ? null : homeWon ? mu.away : mu.home;

    if (week.type !== "playoff") {
      const bump = (id, w, l, t, pf, pa) => {
        const r = { w: 0, l: 0, t: 0, pf: 0, pa: 0, ...(teams[id]?.record || {}) };
        r.w += w; r.l += l; r.t += t;
        r.pf = Math.round((r.pf + pf) * 10) / 10;
        r.pa = Math.round((r.pa + pa) * 10) / 10;
        teams[id] = { ...(teams[id] || {}), record: r };
        batch.set(L.collection("teams").doc(id), { record: r }, { merge: true });
      };
      if (tie) {
        bump(mu.home, 0, 0, 1, mu.homePts, mu.awayPts);
        bump(mu.away, 0, 0, 1, mu.awayPts, mu.homePts);
      } else {
        bump(homeWon ? mu.home : mu.away, 1, 0, 0, homeWon ? mu.homePts : mu.awayPts, homeWon ? mu.awayPts : mu.homePts);
        bump(homeWon ? mu.away : mu.home, 0, 1, 0, homeWon ? mu.awayPts : mu.homePts, homeWon ? mu.homePts : mu.awayPts);
      }
    }
    batch.set(d.ref, { final: true, winner: winners[mu.label || `m${mu.index}`] || null }, { merge: true });
  });

  // Standings → seeds (win% → points-for).
  const seeded = Object.entries(teams)
    .map(([id, t]) => ({ id, r: t.record || { w: 0, l: 0, t: 0, pf: 0 } }))
    .sort((a, b) => {
      const pct = (r) => { const g = r.w + r.l + r.t; return g ? (r.w + 0.5 * r.t) / g : 0; };
      return pct(b.r) - pct(a.r) || (b.r.pf || 0) - (a.r.pf || 0);
    });
  seeded.forEach((t, i) => batch.set(L.collection("teams").doc(t.id), { seed: i + 1 }, { merge: true }));

  // Playoff bracket advancement.
  const S = CFG.SEASON_STRUCTURE;
  const seedOf = Object.fromEntries(seeded.map((t, i) => [t.id, i + 1]));
  const wk = (n) => L.collection("schedule").doc(String(n));

  if (week.type !== "playoff" && week.n === S.regularWeeks) {
    // Regular season over → quarterfinals: 3v6, 4v5 (1–2 byes).
    const byId = seeded.map((t) => t.id);
    batch.set(wk(week.n + 1), {
      week: week.n + 1, type: "playoff",
      matchups: [
        { home: byId[2], away: byId[5], label: "QF1 (3 vs 6)" },
        { home: byId[3], away: byId[4], label: "QF2 (4 vs 5)" },
      ],
      byes: [byId[0], byId[1]],
    });
  } else if (week.type === "playoff") {
    const labels = Object.keys(winners);
    if (labels.some((l) => l.startsWith("QF"))) {
      // Semis: 1 seed vs the worse-seeded QF winner, 2 vs the other.
      const qw = labels.filter((l) => l.startsWith("QF")).map((l) => winners[l]).filter(Boolean);
      qw.sort((a, b) => (seedOf[b] || 9) - (seedOf[a] || 9)); // worst seed first
      const bye = (await wk(week.n).get()).data()?.byes || [];
      batch.set(wk(week.n + 1), {
        week: week.n + 1, type: "playoff",
        matchups: [
          { home: bye[0] || null, away: qw[0] || null, label: "SF1" },
          { home: bye[1] || null, away: qw[1] || null, label: "SF2" },
        ],
      });
    } else if (labels.some((l) => l.startsWith("SF"))) {
      const sfW = labels.filter((l) => l.startsWith("SF")).map((l) => winners[l]).filter(Boolean);
      const prev = (await L.collection("matchups").where("week", "==", week.n).get());
      const sfL = [];
      prev.forEach((d) => {
        const mu = d.data();
        if ((mu.label || "").startsWith("SF") && mu.winner)
          sfL.push(mu.winner === mu.home ? mu.away : mu.home);
      });
      batch.set(wk(week.n + 1), {
        week: week.n + 1, type: "playoff",
        matchups: [
          { home: sfW[0] || null, away: sfW[1] || null, label: "Championship" },
          { home: sfL[0] || null, away: sfL[1] || null, label: "3rd Place" },
        ],
      });
    } else if (labels.some((l) => l.startsWith("Championship"))) {
      const champ = winners["Championship"];
      if (champ) batch.set(L.collection("config").doc("champions"), {
        [settings.season || "season"]: champ,
      }, { merge: true });
    }
  }

  await batch.commit();
  return week.n;
}
