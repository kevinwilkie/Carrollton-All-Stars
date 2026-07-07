/*
 * Carrollton All-Stars — schedule + week-map generator.
 * UMD: used by the Admin tab (browser) and scripts/generate_schedule.mjs (Node).
 *
 * Matchups: circle-method round robin for 12 teams — 11 rounds, then the same
 * 11 rounds with home/away flipped, minus the final rematch round = 21 weeks
 * (every team plays 10 opponents twice and 1 opponent once). A seeded shuffle
 * of team order keeps it fair but reproducible.
 *
 * Week map: Mon–Sun scoring weeks aligned to the MLB calendar — a long opening
 * week (Opening Day → the next Sunday that gives ≥6 days), the All-Star week
 * merged with the following week, and the championship ending on or before the
 * regular season's final Sunday.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScheduleGen = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Deterministic RNG from a string seed (mulberry32).
  function rng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
      h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(arr, seedStr) {
    const r = rng(seedStr);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // teams: array of ids (even count). Returns [{week, matchups:[{home,away}]}] — 21 weeks.
  function generateMatchups(teamIds, seedStr) {
    if (teamIds.length % 2) throw new Error("Need an even number of teams");
    const teams = seededShuffle(teamIds, seedStr || "carrollton");
    const n = teams.length;
    const rounds = [];
    // Circle method: fix teams[0], rotate the rest.
    const rot = teams.slice(1);
    for (let r = 0; r < n - 1; r++) {
      const left = [teams[0]].concat(rot.slice(0, n / 2 - 1));
      const right = rot.slice(n / 2 - 1).reverse();
      const pairs = left.map((t, i) => {
        // Alternate home/away by round so nobody is home 11 straight weeks.
        return (r + i) % 2 ? { home: right[i], away: t } : { home: t, away: right[i] };
      });
      rounds.push(pairs);
      rot.unshift(rot.pop());
    }
    // Second cycle with venues flipped, dropping its last round → 21 weeks.
    const flipped = rounds.map((pairs) => pairs.map((p) => ({ home: p.away, away: p.home })));
    const all = rounds.concat(flipped.slice(0, rounds.length - 1));
    return all.map((matchups, i) => ({ week: i + 1, matchups }));
  }

  // ---- week map -----------------------------------------------------------------
  const DAY = 24 * 3600 * 1000;
  const iso = (d) => d.toISOString().slice(0, 10);
  const at = (isoStr) => new Date(isoStr + "T12:00:00Z");
  const dow = (isoStr) => at(isoStr).getUTCDay(); // 0=Sun
  function nextDow(isoStr, want) {
    let d = at(isoStr);
    while (d.getUTCDay() !== want) d = new Date(d.getTime() + DAY);
    return iso(d);
  }
  function plusDays(isoStr, n) { return iso(new Date(at(isoStr).getTime() + n * DAY)); }

  /*
   * opts: { openingDay, lastDay, allStarDate, regularWeeks (21), playoffWeeks (3) }
   * Returns { weeks: [{n, start, end, type}], notes: [...] } — the commissioner
   * reviews/edits before saving to config/settings.
   */
  function buildWeekMap(opts) {
    const notes = [];
    const total = opts.regularWeeks + opts.playoffWeeks;
    // Long opening week: Opening Day through the Sunday that gives ≥6 days.
    let end1 = nextDow(opts.openingDay, 0);
    if ((at(end1) - at(opts.openingDay)) / DAY < 5) end1 = plusDays(end1, 7);
    const weeks = [{ n: 1, start: opts.openingDay, end: end1, type: "regular" }];

    let cursor = plusDays(end1, 1); // the Monday after week 1
    while (weeks.length < total) {
      let end = plusDays(cursor, 6);
      // Merge the All-Star break's calendar week into a single long week.
      if (opts.allStarDate && cursor <= opts.allStarDate && opts.allStarDate <= end) {
        end = plusDays(end, 7);
        notes.push(`Week ${weeks.length + 1} is a long week spanning the All-Star break (${cursor} → ${end}).`);
      }
      const n = weeks.length + 1;
      weeks.push({ n, start: cursor, end, type: n <= opts.regularWeeks ? "regular" : "playoff" });
      cursor = plusDays(end, 1);
    }

    const lastEnd = weeks[weeks.length - 1].end;
    if (opts.lastDay && lastEnd > opts.lastDay) {
      notes.push(`⚠ Championship week ends ${lastEnd}, after the regular season ends ${opts.lastDay} — ` +
        `shorten by merging two early weeks or trimming a playoff week.`);
    } else if (opts.lastDay) {
      notes.push(`Championship ends ${lastEnd}; MLB regular season runs through ${opts.lastDay}.`);
    }
    return { weeks, notes };
  }

  return { generateMatchups, buildWeekMap, seededShuffle };
});
