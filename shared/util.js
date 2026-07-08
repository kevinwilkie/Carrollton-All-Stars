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

// ---- Theme -------------------------------------------------------------------
// Base looks are CSS blocks keyed on <html data-theme>; MLB team looks reuse the
// dark base and set the team's colors as inline custom properties (computed from
// draft/data/mlb-teams.js TEAM_COLORS). Selection is saved per device as
// localStorage "cas_theme" — one of "classic" | "light" | "vintage" | "mlb:ABBR".
// index.html sets data-theme inline in <head> so the base look has no flash;
// each app calls applyTheme(currentTheme()) on load to paint team colors.
const THEME_BASES = ["classic", "light", "vintage"];
// data-theme keeps the internal id "vintage"; the label shown to users is "All-Stars".
const THEME_LABELS = { classic: "Classic", light: "Light", vintage: "All-Stars" };

function currentTheme() {
  try { return localStorage.getItem("cas_theme") || "classic"; } catch (e) { return "classic"; }
}

// perceived luminance (0–255) and a darken/lighten helper for deriving shades
function _lum(hex) {
  const h = String(hex).replace("#", "");
  if (h.length < 6) return 128;
  return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16);
}
function _shift(hex, amt) {   // amt<0 → toward black, amt>0 → toward white
  const h = String(hex).replace("#", "");
  if (h.length < 6) return hex;
  const ch = [0, 2, 4].map((i) => {
    let v = parseInt(h.slice(i, i + 2), 16);
    v = amt < 0 ? Math.round(v * (1 + amt)) : Math.round(v + (255 - v) * amt);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  });
  return "#" + ch.join("");
}

const _TEAM_VARS = [
  "--accent", "--accent-deep", "--on-accent", "--brand-bg", "--brand-fg", "--brand-sub",
  "--ink", "--ink-2", "--panel", "--panel-2", "--hover", "--line", "--bg-glow", "--text", "--muted", "--cream",
];
function _applyTeamColors(root, c) {
  const P = c.primary;
  let accent = c.secondary || c.primary;
  // keep the accent bright enough to read on the dark, team-tinted surfaces
  if (_lum(accent) < 70) accent = (c.alt && _lum(c.alt) >= 70) ? c.alt : _shift(accent, 0.45);
  const set = (k, v) => root.style.setProperty(k, v);

  // Whole-surface team tint: every panel is a very dark shade of the primary
  // (mixing toward black keeps it dark and readable for any team color).
  set("--ink", _shift(P, -0.88));
  set("--ink-2", _shift(P, -0.85));
  set("--panel", _shift(P, -0.80));
  set("--panel-2", _shift(P, -0.72));
  set("--hover", _shift(P, -0.66));
  set("--line", _shift(P, -0.52));
  set("--bg-glow", `radial-gradient(1200px 600px at 80% -10%, ${_shift(P, -0.72)} 0, ${_shift(P, -0.9)} 55%)`);
  set("--text", "#f2f5fb");
  set("--muted", "#aab4c6");
  set("--cream", "#f2e8d5");

  // Brand bar = the team's primary; accent = its pop color.
  set("--brand-bg", P);
  set("--brand-fg", _lum(P) > 150 ? "#12141c" : "#ffffff");
  set("--brand-sub", accent);
  set("--accent", accent);
  set("--accent-deep", _shift(accent, -0.2));
  set("--on-accent", _lum(accent) > 150 ? "#12141c" : "#ffffff");
}

function applyTheme(id) {
  const root = document.documentElement;
  _TEAM_VARS.forEach((v) => root.style.removeProperty(v));
  if (id && id.indexOf("mlb:") === 0) {
    root.dataset.theme = "classic";                       // team looks sit on the dark base
    const c = (typeof TEAM_COLORS !== "undefined") && TEAM_COLORS[id.slice(4)];
    if (c) _applyTeamColors(root, c);
  } else {
    root.dataset.theme = id || "classic";
  }
  try { localStorage.setItem("cas_theme", id); } catch (e) {}
}

// Draft board keeps a single button that cycles the three base looks.
function themeLabel() { return "🎨 " + (THEME_LABELS[currentTheme()] || "Theme"); }
function wireThemeButton(btn) {
  if (!btn) return;
  applyTheme(currentTheme());
  btn.textContent = themeLabel();
  btn.addEventListener("click", () => {
    const i = THEME_BASES.indexOf(currentTheme());   // team theme → -1 → steps to classic
    applyTheme(THEME_BASES[(i + 1) % THEME_BASES.length]);
    btn.textContent = themeLabel();
  });
}

// ---- Sticky offsets ------------------------------------------------------------
// The tabs bar sticks below the topbar via top: var(--header-h). The topbar
// wraps to two rows on phones, so measure it rather than hardcoding a height.
function trackHeaderHeight() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const set = () =>
    document.documentElement.style.setProperty("--header-h", bar.offsetHeight + "px");
  if (window.ResizeObserver) new ResizeObserver(set).observe(bar);
  else window.addEventListener("resize", set);
  set();
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
