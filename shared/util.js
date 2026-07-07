/*
 * Carrollton All-Stars — shared browser utilities (season app + draft board).
 * Loaded as a plain <script>; everything hangs off the page globals below.
 */
"use strict";

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Loose name key for matching across sources (ESPN AAV ↔ MLB names):
// lowercase, strip punctuation + Jr/Sr/II suffixes, collapse spaces.
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents (Acuña → acuna)
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Dates in league time (America/New_York) --------------------------------
// The fantasy "day" follows US Eastern time: a 10pm PT game still belongs to
// that ET date. All Firestore day keys use this format.
const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
function etDate(d) { return ET_FMT.format(d || new Date()); } // "YYYY-MM-DD"
function addDays(iso, days) {
  const d = new Date(iso + "T12:00:00Z"); // noon UTC avoids DST edge flips
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDay(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function fmtTimeET(isoUtc) {
  return new Date(isoUtc).toLocaleTimeString("en-US",
    { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

// ---- Theme ("classic" dark / "vintage" logo palette) --------------------------
// Applied per device; both apps call wireThemeButton() on their topbar button.
// index.html also sets data-theme inline in <head> so there's no flash.
function themeLabel() {
  return document.documentElement.dataset.theme === "vintage" ? "🌙 Classic" : "⭐ Vintage";
}
function wireThemeButton(btn) {
  if (!btn) return;
  btn.textContent = themeLabel();
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "vintage" ? "classic" : "vintage";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("cas_theme", next); } catch (e) {}
    btn.textContent = themeLabel();
  });
}

// ---- Toast -------------------------------------------------------------------
let _toastTimer = null;
function toast(msg, kind) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast" + (kind ? " toast-" + kind : "");
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---- Avatars -----------------------------------------------------------------
// MLB headshots are keyed by mlbId — no scraping needed (unlike the NFL apps).
// Two-way split ids like "660271:B" resolve to the person's numeric id.
function headshotUrl(mlbId, size) {
  const person = (String(mlbId).match(/^\d+/) || [""])[0];
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${size || 120},q_auto:best/v1/people/${person}/headshot/67/current`;
}
function initialsOf(name) {
  const w = String(name || "").replace(/[^A-Za-z .'-]/g, "").split(/\s+/).filter(Boolean);
  return (((w[0] || "")[0] || "") + ((w[w.length - 1] || "")[0] || "")).toUpperCase();
}
// Round avatar: colored initials underneath, headshot on top when it loads.
function avatarHTML(player, size) {
  const id = player && (player.mlbId || player.id);
  const img = id
    ? `<img src="${headshotUrl(id, Math.max(64, size * 2))}" alt="" loading="lazy"` +
      ` onload="this.closest('.avatar').classList.add('has-photo')"` +
      ` onerror="this.remove()">`
    : "";
  return `<span class="avatar" style="--sz:${size}px">` +
    `<span class="avatar-initials">${escapeHtml(initialsOf(player && player.name))}</span>${img}</span>`;
}

// Position badges — a player can carry several (["2B","SS"]).
function posBadges(positions, cls) {
  return (positions || []).map((p) =>
    `<span class="pos-badge pos-${escapeHtml(p)}${cls ? " " + cls : ""}">${escapeHtml(p)}</span>`).join("");
}
