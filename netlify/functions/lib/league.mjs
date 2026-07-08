/*
 * League/date helpers shared by every scheduled function.
 * The fantasy "day" is the US-Eastern calendar date (a 10pm PT game still
 * belongs to that ET date). Week boundaries come from config/settings.weeks.
 */
import cfg from "../../../shared/league-config.js";

export const CFG = cfg;

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
export function etDate(d = new Date()) {
  return ET_FMT.format(d); // "YYYY-MM-DD"
}
export function addDays(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// weeks: [{ n, start: "YYYY-MM-DD", end: "YYYY-MM-DD", type: "regular"|"playoff" }]
export function weekFor(dateISO, weeks) {
  return (weeks || []).find((w) => w.start <= dateISO && dateISO <= w.end) || null;
}
export function datesOfWeek(week) {
  const out = [];
  for (let d = week.start; d <= week.end; d = addDays(d, 1)) out.push(d);
  return out;
}

// Slots that score points (bench/IL don't).
export function isActiveSlot(slot) {
  return slot && slot !== "BN" && slot !== "IL" && !/^BN\d/.test(slot) && !/^IL\d/.test(slot);
}

// Worse record first: lower win% → fewer points-for → stable id/name tiebreak.
// The final tiebreak must be DETERMINISTIC: a live coin flip made this a
// non-transitive comparator (undefined behavior for Array.sort) and resolved
// FAAB ties differently on every re-run/retry. A true tie here needs identical
// win% AND identical points-for, so this alphabetical fallback is effectively
// never hit — it exists to keep the sort a consistent total order.
export function worseRecordFirst(a, b) {
  const pct = (r) => {
    const g = (r.w || 0) + (r.l || 0) + (r.t || 0);
    return g ? ((r.w || 0) + 0.5 * (r.t || 0)) / g : 0;
  };
  return pct(a.record || {}) - pct(b.record || {}) ||
    ((a.record || {}).pf || 0) - ((b.record || {}).pf || 0) ||
    String(a.id || a.name || "").localeCompare(String(b.id || b.name || ""));
}
