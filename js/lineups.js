/*
 * My Team tab — the daily lineup editor (Yahoo/Sleeper style).
 *   • Tap a position chip → pick any eligible player for that spot (the one
 *     it replaces swaps positions if it fits, otherwise drops to the bench).
 *   • Tap a bench player's chip → pick which lineup slot to move him into.
 *   • Tap a player → a card with his info, stats, eligibility and status.
 * Players lock at their game's first pitch (the ingest job snapshots locks;
 * the UI also treats any started game as locked so the two never disagree).
 */
"use strict";

let luRoster = null;       // my roster doc
let luScore = null;        // my score doc for the viewed week
let luLoading = false;

const ACTIVE_KEYS = SLOT_KEYS.filter(isActiveSlot);
const IL_KEYS = SLOT_KEYS.filter((k) => slotType(k) === "IL");
const HITTER_SLOT_TYPES = ["C", "1B", "2B", "3B", "SS", "INF", "OF", "UTIL"];
function isHitterSlot(k) { return HITTER_SLOT_TYPES.includes(slotType(k)); }
// A player belongs on the pitcher side only if every eligible position is SP/RP.
function isPitcherPlayer(p) {
  const pos = (p && p.positions) || [];
  return pos.length > 0 && pos.every((x) => x === "SP" || x === "RP");
}

// Friendly names for slot pickers.
const SLOT_LABEL = {
  C: "Catcher", "1B": "First Base", "2B": "Second Base", "3B": "Third Base",
  SS: "Shortstop", INF: "Infield (CI/MI)", OF: "Outfield", UTIL: "Utility",
  SP: "Starting Pitcher", RP: "Relief Pitcher", IL: "Injured List",
};
function slotLabel(k) { return SLOT_LABEL[slotType(k)] || slotType(k); }

async function ensureMyTeamData() {
  if (luLoading || !App.myTeamId || !App.fs) return;
  luLoading = true;
  try {
    await loadPlayers();
    luRoster = await loadRoster(App.myTeamId, true);
    const wk = weekFor(App.date);
    luScore = wk ? await loadScore(App.myTeamId, wk.n, true) : null;
  } finally {
    luLoading = false;
  }
  renderActive();
}

function rosterIds() {
  return luRoster ? Object.keys(luRoster.players || {}) : [];
}

// The current lineup as { active:{slotKey:id|null}, il:{ilKey:id|null} }.
// Bench is everything on the roster not sitting in one of those slots, so it
// grows past six whenever a starting slot is left open.
function currentAssignment() {
  const active = Object.fromEntries(ACTIVE_KEYS.map((k) => [k, null]));
  const il = Object.fromEntries(IL_KEYS.map((k) => [k, null]));
  const roster = new Set(rosterIds());
  const saved = App.lineup && App.lineup.slots;
  if (saved) {
    ACTIVE_KEYS.forEach((k) => { const v = saved[k] && String(saved[k]); if (v && roster.has(v)) active[k] = v; });
    IL_KEYS.forEach((k) => { const v = saved[k] && String(saved[k]); if (v && roster.has(v)) il[k] = v; });
    return { active, il };
  }
  if (!luRoster) return { active, il };
  // No saved doc yet: seed a legal lineup from the roster via the matcher.
  const players = rosterIds().map((id) => ({ mlbId: id, positions: metaOf(id).positions || [] }));
  const nonIL = SLOT_KEYS.filter((k) => slotType(k) !== "IL");
  const { cells, overflow } = Feasibility.assignSlots(players);
  cells.forEach((c, i) => { const k = nonIL[i]; if (c.player && isActiveSlot(k)) active[k] = String(c.player.mlbId); });
  overflow.forEach((p, i) => { if (IL_KEYS[i]) il[IL_KEYS[i]] = String(p.mlbId); });
  return { active, il };
}

function benchIds(active, il) {
  const seated = new Set([...Object.values(active), ...Object.values(il)].filter(Boolean));
  return rosterIds().filter((id) => !seated.has(id));
}

// Persist active+IL; bench players trail under sequential BN keys (which may
// exceed six — the scoring job only ever reads the active slots).
async function persistAssignment(active, il) {
  const slots = {};
  ACTIVE_KEYS.forEach((k) => { slots[k] = active[k] || null; });
  IL_KEYS.forEach((k) => { slots[k] = il[k] || null; });
  benchIds(active, il).forEach((id, i) => { slots[`BN${i + 1}`] = id; });
  App.lineup = { ...(App.lineup || { teamId: App.myTeamId, date: App.date }), slots };  // optimistic
  await saveLineupSlots(slots);
}

function gameFor(player) {
  if (!App.mlbDay || !player) return null;
  return (App.mlbDay.games || []).find(
    (g) => g.homeId === player.mlbTeamId || g.awayId === player.mlbTeamId) || null;
}
function isLockedNow(mlbId, player) {
  if (App.date < etDate()) return true;                       // past days are read-only
  if (App.lineup && App.lineup.locked && App.lineup.locked[String(mlbId)]) return true;
  if (App.date > etDate()) return false;
  const g = gameFor(player);
  return !!(g && g.firstPitchUTC && g.firstPitchUTC <= new Date().toISOString());
}
function playerFitsSlotKey(player, slotKey) {
  const t = slotType(slotKey);
  if (t === "IL") return !!(player && player.ilStatus);
  return Feasibility.playerFitsSlot((player && player.positions) || [], t);
}

function metaOf(mlbId) {
  const p = playerOf(mlbId);
  if (p) return p;
  const r = luRoster && luRoster.players && (luRoster.players[String(mlbId)] || luRoster.players[mlbId]);
  return r ? { mlbId, name: r.name, positions: r.positions || [], mlbTeam: r.mlbTeam || "" } : { mlbId, name: "#" + mlbId, positions: [] };
}

function mlbAbbr(mlbTeamId) {
  const t = (typeof TEAMS !== "undefined" ? TEAMS : []).find((x) => x.id === mlbTeamId);
  return t ? t.abbr : "";
}

// "7:10 PM ET @ CIN" / "● Live vs MIA" / "Final @ TB" / "No game"
function gameLineHTML(player) {
  const g = gameFor(player);
  if (!g) return `<span class="lu-game none">No game</span>`;
  const oppId = player.mlbTeamId === g.homeId ? g.awayId : g.homeId;
  const opp = `${player.mlbTeamId === g.homeId ? "vs" : "@"} ${mlbAbbr(oppId) || "—"}`;
  if (g.status === "Final") return `<span class="lu-game">Final ${opp}</span>`;
  if (g.status === "Live") return `<span class="lu-game live">● Live ${opp}</span>`;
  return `<span class="lu-game">${g.firstPitchUTC ? fmtTimeET(g.firstPitchUTC) : ""} ${opp}</span>`;
}

function ordinal(n) {
  return n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");
}
function myRank() {
  const pct = (r) => { const g = (r.w || 0) + (r.l || 0) + (r.t || 0); return g ? ((r.w || 0) + 0.5 * (r.t || 0)) / g : 0; };
  const ids = Object.entries(App.teams)
    .sort(([, a], [, b]) => pct(b.record || {}) - pct(a.record || {}) || ((b.record || {}).pf || 0) - ((a.record || {}).pf || 0))
    .map(([id]) => id);
  const i = ids.indexOf(App.myTeamId);
  return i < 0 ? null : `${ordinal(i + 1)} of ${ids.length}`;
}

// ---- moving players around --------------------------------------------------
// The single primitive: put `playerId` into `targetSlot`, displacing whoever's
// there. If the mover came from another slot and the displaced player fits that
// slot, they swap; otherwise the displaced player drops to the bench. Locked
// players (game started) never move. Returns "" on success or an error string.
function tryMove(active, il, playerId, targetSlot) {
  const map = { ...active, ...il };
  const setSlot = (k, v) => { if (IL_KEYS.includes(k)) il[k] = v; else active[k] = v; };
  const p = playerOf(playerId) || metaOf(playerId);
  const occupant = map[targetSlot] || null;
  if (!playerFitsSlotKey(p, targetSlot))
    return `${metaOf(playerId).name} can't fill ${slotLabel(targetSlot)}${slotType(targetSlot) === "IL" ? " (not on an MLB IL)" : ""}.`;
  if (isLockedNow(playerId, playerOf(playerId)))
    return `${metaOf(playerId).name} is locked.`;
  if (occupant && isLockedNow(occupant, playerOf(occupant)))
    return `${metaOf(occupant).name} is locked.`;
  const fromSlot = Object.keys(map).find((k) => map[k] === playerId) || null;
  setSlot(targetSlot, playerId);
  if (fromSlot && fromSlot !== targetSlot) {
    if (occupant && playerFitsSlotKey(playerOf(occupant) || metaOf(occupant), fromSlot)) setSlot(fromSlot, occupant);
    else setSlot(fromSlot, null);   // occupant → bench
  }
  return "";
}

async function moveIntoSlot(playerId, targetSlot) {
  if (App.date < etDate()) return;
  const { active, il } = currentAssignment();
  const err = tryMove(active, il, playerId, targetSlot);
  if (err) return toast(err, "error");
  await saveAndToast(active, il);
}

async function benchPlayer(playerId) {
  if (App.date < etDate()) return;
  const { active, il } = currentAssignment();
  const slot = Object.keys({ ...active, ...il }).find((k) => (active[k] || il[k]) === playerId);
  if (!slot) return;
  if (isLockedNow(playerId, playerOf(playerId))) return toast(`${metaOf(playerId).name} is locked.`, "error");
  if (IL_KEYS.includes(slot)) il[slot] = null; else active[slot] = null;
  await saveAndToast(active, il);
}

async function saveAndToast(active, il) {
  try {
    await persistAssignment(active, il);
    toast("Lineup saved.", "success");
  } catch (e) {
    toast("Couldn't save lineup: " + (e.message || "permission denied"), "error");
  }
  closeSheet();
  renderActive();
}

// "Start Active Players": fill open active slots with benched players who have
// a game today, then bench any starter with no game in favor of one who plays.
async function startActivePlayers() {
  if (App.date < etDate()) return;
  const { active, il } = currentAssignment();
  const hasGame = (id) => !!gameFor(playerOf(id));
  const movable = (id) => id && playerOf(id) && !isLockedNow(id, playerOf(id));
  let moves = 0, changed = true;
  while (changed) {
    changed = false;
    for (const bid of benchIds(active, il)) {
      if (!movable(bid) || !hasGame(bid)) continue;
      const bp = playerOf(bid);
      let target = ACTIVE_KEYS.find((k) => !active[k] && playerFitsSlotKey(bp, k));
      if (!target) target = ACTIVE_KEYS.find((k) => movable(active[k]) && !hasGame(active[k]) && playerFitsSlotKey(bp, k));
      if (target) { if (!tryMove(active, il, bid, target)) { moves++; changed = true; break; } }
    }
  }
  if (!moves) return toast("Everyone with a game today is already starting.", "success");
  try {
    await persistAssignment(active, il);
    toast(`Moved ${moves} player${moves > 1 ? "s" : ""} into the lineup.`, "success");
  } catch (e) {
    toast("Couldn't save lineup: " + (e.message || "permission denied"), "error");
  }
  renderActive();
}

function renderMyTeam() {
  const host = $("#view-myteam");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (!App.myTeamId) return host.innerHTML =
    `<div class="card"><h3>My Team</h3><p class="hint">This Google account isn't linked to a team. ` +
    `Ask the commissioner to add your email to the league config.</p></div>`;
  if (!App.players || !luRoster) { ensureMyTeamData(); return host.innerHTML = `<div class="empty-note">Loading roster…</div>`; }

  const { active, il } = currentAssignment();
  const today = etDate();
  const wk = weekFor(App.date);
  const editable = App.date >= today;

  const dayPts = (luScore && luScore.byPlayerDays && luScore.byPlayerDays[App.date]) || {};
  const dayTotal = (luScore && luScore.byDay && luScore.byDay[App.date]) ?? null;
  const ptsOf = (id) => (dayPts[String(id)] ? dayPts[String(id)].points : null);

  // A filled row. `chipType` drives the chip: the slot type for a lineup slot,
  // or the player's lead position for a bench row.
  const filledRow = (id, slotKey, chipType, kind) => {
    const p = metaOf(id);
    const live = playerOf(id);
    const locked = isLockedNow(id, live);
    const pts = ptsOf(id);
    const ilBad = kind === "il" && live && !live.ilStatus;
    const cls = kind === "bench" ? " bench" : kind === "il" ? " il" : "";
    const chipCls = kind === "bench" ? "chip-BN" : "chip-" + chipType;
    return `<div class="lu-row${cls}" data-id="${id}">` +
      `<button class="slot-chip ${chipCls}${editable && !locked ? " tappable" : ""}" ` +
      `data-act="${kind === "bench" ? "move-in" : "fill"}" data-slot="${slotKey}" data-id="${id}" ` +
      `title="${escapeHtml(kind === "bench" ? "Move into the lineup" : "Choose a " + slotLabel(slotKey))}">` +
      `${chipType}${editable && !locked ? `<span class="chip-caret">▾</span>` : ""}</button>` +
      `<span class="lu-player" data-act="card" data-id="${id}">${avatarHTML(p, 34)}` +
      `<span class="lu-stack"><span class="lu-name">${escapeHtml(p.name)}</span>` +
      `<span class="lu-meta">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
      `${live && live.ilStatus ? ` <span class="il-flag">${escapeHtml(live.ilStatus)}</span>` : ""}` +
      `${ilBad ? ` <span class="il-flag">⚠ not on MLB IL</span>` : ""}</span>` +
      `${live ? gameLineHTML(live) : `<span class="lu-game none">No game</span>`}</span></span>` +
      `<span class="lu-right"><span class="lu-pts">${pts != null ? pts : "—"}</span>` +
      `${locked ? `<span class="lu-lock">🔒</span>` : ""}</span></div>`;
  };

  const emptyRow = (slotKey) =>
    `<div class="lu-row empty" data-act="fill" data-slot="${slotKey}">` +
    `<span class="slot-chip chip-${slotType(slotKey)}${editable ? " tappable" : ""}">${slotType(slotKey)}` +
    `${editable ? `<span class="chip-caret">＋</span>` : ""}</span>` +
    `<span class="lu-empty">${editable ? "Empty — tap to fill" : "Empty"}</span></div>`;

  const slotRow = (slotKey, kind) => {
    const id = (kind === "il" ? il : active)[slotKey];
    return id ? filledRow(id, slotKey, slotType(slotKey), kind) : emptyRow(slotKey);
  };

  const bench = benchIds(active, il).map(metaOf);
  const benchHit = bench.filter((p) => !isPitcherPlayer(p));
  const benchPit = bench.filter((p) => isPitcherPlayer(p));
  const leadPos = (p) => (p.positions || []).find((x) => x !== "SP" && x !== "RP") || (p.positions || [])[0] || "BN";
  const benchRows = (list) => list.map((p) => filledRow(p.mlbId, null, leadPos(p), "bench")).join("");

  const hitterSlots = ACTIVE_KEYS.filter(isHitterSlot);
  const pitcherSlots = ACTIVE_KEYS.filter((k) => !isHitterSlot(k));
  const benchDivider = (n) => `<div class="bench-divider"><span>Bench</span><i>${n}</i></div>`;

  const battersSec = `<div class="sec-head">Batters</div>` +
    hitterSlots.map((k) => slotRow(k, "active")).join("") +
    (benchHit.length ? benchDivider(benchHit.length) + benchRows(benchHit) : "");
  const pitchersSec = `<div class="sec-head">Pitchers</div>` +
    pitcherSlots.map((k) => slotRow(k, "active")).join("") +
    (benchPit.length ? benchDivider(benchPit.length) + benchRows(benchPit) : "");
  const ilSec = `<div class="sec-head">Injured List</div>` +
    IL_KEYS.map((k) => slotRow(k, "il")).join("");

  // ---- Team summary card (record · rank · owner, week points, shortcuts) ----
  const cfgTeam = LEAGUE_TEAMS.find((x) => x.id === App.myTeamId) || {};
  const rank = myRank();
  const startsUsed = luScore && luScore.startsUsed != null ? luScore.startsUsed : null;
  const weekPts = (luScore && luScore.total) ?? 0;
  const card =
    `<div class="card team-card">` +
    `<div class="tc-main">${avatarHTML({ name: teamName(App.myTeamId) }, 52)}` +
    `<div class="tc-text"><div class="tc-name">${escapeHtml(teamName(App.myTeamId))}</div>` +
    `<div class="tc-sub">${teamRecord(App.myTeamId)}${rank ? ` · ${rank}` : ""}` +
    `${cfgTeam.owner ? ` · ${escapeHtml(cfgTeam.owner)}` : ""}</div></div>` +
    `<div class="tc-pts"><b>${weekPts}</b><span>${wk ? `Week ${wk.n} pts` : "points"}</span></div></div>` +
    `<div class="tc-actions">` +
    `<button class="tc-link" data-goto="schedule">🗓️ Schedule</button>` +
    `<button class="tc-link" data-goto="trades">🔁 Trade</button>` +
    `<button class="tc-link" data-goto="transactions">📋 Activity</button>` +
    (startsUsed != null
      ? `<span class="pill${startsUsed >= PITCHING.maxStartsPerWeek ? " pill-warn" : ""}" ` +
        `title="Only ${PITCHING.maxStartsPerWeek} pitcher starts count per week">` +
        `${startsUsed}/${PITCHING.maxStartsPerWeek} SP starts</span>`
      : "") +
    `</div></div>`;

  // ---- Date navigation (yesterday … +7 days) + auto-start ----
  const canPrev = App.date > addDays(today, -1);
  const canNext = App.date < addDays(today, 7);
  const dateLabel = App.date === today ? `Today · ${fmtDay(App.date)}`
    : App.date === addDays(today, 1) ? `Tomorrow · ${fmtDay(App.date)}` : fmtDay(App.date);
  const dateNav =
    `<div class="date-nav">` +
    `<button class="dn-arrow" id="dn-prev" ${canPrev ? "" : "disabled"} aria-label="Previous day">‹</button>` +
    `<button class="dn-label" id="dn-today" title="Jump back to today">${dateLabel}</button>` +
    `<button class="dn-arrow" id="dn-next" ${canNext ? "" : "disabled"} aria-label="Next day">›</button>` +
    (dayTotal != null ? `<span class="pill">${dayTotal} pts</span>` : "") +
    (editable ? `<button class="btn btn-ghost btn-small" id="btn-start-active">⚡ Start active players</button>` : "") +
    `</div>`;

  host.innerHTML =
    card + dateNav +
    `<p class="hint">${editable
      ? "Tap a position to pick a player for that spot, or tap a player to see his card. 🔒 = locked (game started)."
      : "This day is final — lineups are read-only."}</p>` +
    `<div class="lineup-grid">${battersSec}${pitchersSec}${ilSec}</div>`;

  const go = (days) => {
    App.date = addDays(App.date, days);
    luScore = null;
    subscribeDay();
    ensureMyTeamData();
  };
  const prev = $("#dn-prev"), next = $("#dn-next");
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
  $("#dn-today").addEventListener("click", () => { if (App.date !== today) { App.date = today; luScore = null; subscribeDay(); ensureMyTeamData(); } });
  host.querySelectorAll(".tc-link").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.goto)));
  const sa = $("#btn-start-active");
  if (sa) sa.addEventListener("click", startActivePlayers);

  host.querySelectorAll("[data-act]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const { act, slot, id } = el.dataset;
      if (act === "card") return openPlayerCard(id);
      if (!editable) return;
      if (act === "fill") return openFillPicker(slot);
      if (act === "move-in") return openMovePicker(id);
    }));
}

// ---- Bottom-sheet helper -------------------------------------------------------
// One reusable overlay, created lazily and appended to <body>. Closes on
// backdrop tap, the ✕, or Escape.
function ensureSheetHost() {
  let host = $("#mt-sheet");
  if (host) return host;
  host = document.createElement("div");
  host.id = "mt-sheet";
  host.className = "modal-overlay";
  host.hidden = true;
  host.addEventListener("click", (e) => { if (e.target === host) closeSheet(); });
  document.body.appendChild(host);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  return host;
}
function closeSheet() { const h = $("#mt-sheet"); if (h) { h.hidden = true; h.innerHTML = ""; } }
function openSheet(innerHTML, wide) {
  const host = ensureSheetHost();
  host.innerHTML = `<div class="modal${wide ? " modal-wide" : ""}"><div class="sheet-grab"></div>` +
    `<button class="sheet-close" data-close aria-label="Close">✕</button>${innerHTML}</div>`;
  host.hidden = false;
  host.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  return host;
}

// A candidate/target row inside a picker.
function pickerRow(id, tag, act, slot) {
  const p = metaOf(id), live = playerOf(id);
  const locked = isLockedNow(id, live);
  return `<button class="pick-row${locked ? " locked" : ""}" ${locked ? "disabled" : ""} ` +
    `data-pick="${act}" data-id="${id}"${slot ? ` data-slot="${slot}"` : ""}>` +
    `${avatarHTML(p, 30)}<span class="lu-stack"><span class="lu-name">${escapeHtml(p.name)}</span>` +
    `<span class="lu-meta">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
    `${live && live.ilStatus ? ` <span class="il-flag">${escapeHtml(live.ilStatus)}</span>` : ""}</span>` +
    `${live ? gameLineHTML(live) : ""}</span>` +
    `<span class="pick-tag">${locked ? "🔒" : escapeHtml(tag || "")}</span></button>`;
}

// Tap a lineup slot → choose who fills it.
function openFillPicker(slotKey) {
  const { active, il } = currentAssignment();
  const occupant = (IL_KEYS.includes(slotKey) ? il : active)[slotKey];
  if (occupant && isLockedNow(occupant, playerOf(occupant)))
    return toast(`${metaOf(occupant).name} is locked.`, "error");
  const seated = { ...active, ...il };
  const eligible = rosterIds().filter((id) => id !== occupant && playerFitsSlotKey(playerOf(id) || metaOf(id), slotKey));
  const onBench = eligible.filter((id) => !Object.values(seated).includes(id));
  const inLineup = eligible.filter((id) => Object.values(seated).includes(id));
  const slotOf = (id) => Object.keys(seated).find((k) => seated[k] === id);

  if (!eligible.length && !occupant)
    return toast(`No one on your roster is eligible for ${slotLabel(slotKey)}.`, "error");

  let body = `<h2>Choose a ${escapeHtml(slotLabel(slotKey))}</h2>`;
  if (occupant) body += `<div class="pick-sub">Currently: <b>${escapeHtml(metaOf(occupant).name)}</b>` +
    ` · <button class="link-btn" data-pick="bench" data-id="${occupant}">Move to bench</button></div>`;
  if (onBench.length) body += `<div class="pick-group">From your bench</div>` +
    onBench.map((id) => pickerRow(id, "Start", "fill", slotKey)).join("");
  if (inLineup.length) body += `<div class="pick-group">Swap from your lineup</div>` +
    inLineup.map((id) => pickerRow(id, slotType(slotOf(id)), "fill", slotKey)).join("");
  if (!onBench.length && !inLineup.length) body += `<p class="empty-note">No other eligible players.</p>`;

  const host = openSheet(body);
  host.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.id;
    if (b.dataset.pick === "bench") return benchPlayer(id);
    moveIntoSlot(id, slotKey);
  }));
}

// Tap a bench player's chip → choose which slot he goes into.
function openMovePicker(playerId) {
  const p = playerOf(playerId) || metaOf(playerId);
  if (isLockedNow(playerId, playerOf(playerId))) return toast(`${metaOf(playerId).name} is locked.`, "error");
  const { active, il } = currentAssignment();
  const targets = ACTIVE_KEYS.concat(IL_KEYS).filter((k) => playerFitsSlotKey(p, k));
  if (!targets.length) return toast(`${metaOf(playerId).name} isn't eligible for any open slot.`, "error");

  let body = `<h2>Move ${escapeHtml(metaOf(playerId).name)} into…</h2>`;
  body += targets.map((k) => {
    const occ = (IL_KEYS.includes(k) ? il : active)[k];
    const occLocked = occ && isLockedNow(occ, playerOf(occ));
    return `<button class="pick-row${occLocked ? " locked" : ""}" ${occLocked ? "disabled" : ""} data-slot="${k}">` +
      `<span class="slot-chip chip-${slotType(k)}">${slotType(k)}</span>` +
      `<span class="lu-stack"><span class="lu-name">${escapeHtml(slotLabel(k))}</span>` +
      `<span class="lu-meta">${occ ? "Swap with " + escapeHtml(metaOf(occ).name) : "Open slot"}</span></span>` +
      `<span class="pick-tag">${occLocked ? "🔒" : occ ? "Swap" : "Start"}</span></button>`;
  }).join("");

  const host = openSheet(body);
  host.querySelectorAll("[data-slot]").forEach((b) =>
    b.addEventListener("click", () => moveIntoSlot(playerId, b.dataset.slot)));
}

// ---- Player card ----------------------------------------------------------------
function weekPtsFor(id) {
  if (!luScore || !luScore.byPlayerDays) return null;
  let s = 0, found = false;
  Object.values(luScore.byPlayerDays).forEach((day) => {
    if (day[String(id)]) { s += day[String(id)].points || 0; found = true; }
  });
  return found ? Math.round(s * 10) / 10 : null;
}

function openPlayerCard(id) {
  const p = metaOf(id), live = playerOf(id) || {};
  const abbr = p.mlbTeam || live.mlbTeam || "";
  const colors = (typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[abbr]) || null;
  const band = colors ? colors.primary : "var(--panel-2)";
  const band2 = colors ? (colors.secondary || colors.primary) : "var(--panel)";

  const { active, il } = currentAssignment();
  const seated = { ...active, ...il };
  const inSlot = Object.keys(seated).find((k) => seated[k] === String(id));
  const onMyRoster = rosterIds().includes(String(id));
  const editable = App.date >= etDate() && onMyRoster;

  // Ownership
  const owner = live.rosteredBy ? teamName(live.rosteredBy) : null;
  const status = onMyRoster ? "On your roster" : owner ? `Rostered by ${owner}` : "Free agent";

  // Stat tiles
  const wp = weekPtsFor(id), dp = (luScore && luScore.byPlayerDays && luScore.byPlayerDays[App.date]
    && luScore.byPlayerDays[App.date][String(id)] || {}).points;
  const appr = live.apprThisSeason || {};
  const games = Object.values(appr).reduce((a, b) => a + b, 0) + (live.pitchedThisSeason || 0);
  const tiles = [
    [wp != null ? wp : "—", "WEEK PTS"],
    [dp != null ? dp : "—", "TODAY"],
    [games || "—", "GAMES"],
    [(p.positions || []).length || "—", "SLOTS"],
  ];

  // Eligibility breakdown
  const parts = [];
  Object.entries(appr).sort((a, b) => b[1] - a[1]).forEach(([pos, g]) => parts.push(`${pos}: ${g} G`));
  if (live.gsThisSeason) parts.push(`SP: ${live.gsThisSeason} GS`);
  if (live.reliefThisSeason) parts.push(`RP: ${live.reliefThisSeason} apps`);

  const g = gameFor(live.mlbTeamId ? live : p);

  let actions = "";
  if (editable) {
    const locked = isLockedNow(id, live);
    if (locked) actions = `<p class="hint">🔒 Locked — his game has started.</p>`;
    else {
      const btns = [];
      if (inSlot && !IL_KEYS.includes(inSlot)) btns.push(`<button class="btn btn-ghost" data-card="bench">Move to bench</button>`);
      if (!inSlot) btns.push(`<button class="btn" data-card="start">Move into lineup</button>`);
      if (live.ilStatus && !(inSlot && IL_KEYS.includes(inSlot))) btns.push(`<button class="btn btn-ghost" data-card="il">Move to IL</button>`);
      if (inSlot && IL_KEYS.includes(inSlot)) btns.push(`<button class="btn" data-card="activate">Activate</button>`);
      actions = `<div class="pc-actions">${btns.join("")}</div>`;
    }
  }

  const summaryHTML =
    (g ? `<div class="pc-game">${g.status === "Final" ? "Final" : g.status === "Live" ? "● Live" : (g.firstPitchUTC ? fmtTimeET(g.firstPitchUTC) : "Today")}` +
      ` · ${g.homeId === live.mlbTeamId ? "vs " + (mlbAbbr(g.awayId) || "") : "@ " + (mlbAbbr(g.homeId) || "")}</div>` : "") +
    `<div class="pc-sec">Position eligibility</div>` +
    `<div class="pc-badges">${posBadges(p.positions, "") || "<span class='hint'>—</span>"}</div>` +
    (parts.length ? `<p class="hint">${escapeHtml(parts.join(" · "))} · this season</p>` : "") +
    (live.statusDescription ? `<p class="hint">${escapeHtml(live.statusDescription)}</p>` : "");

  const body =
    `<div class="pc-head" style="background:linear-gradient(120deg,${band},${band2})">` +
    `<div class="pc-id">${avatarHTML(p, 66)}` +
    `<div class="pc-name-wrap"><div class="pc-name">${escapeHtml(p.name)}</div>` +
    `<div class="pc-sub">${(p.positions || []).join(", ") || "—"}${abbr ? " · " + escapeHtml(abbr) : ""}</div>` +
    `<span class="pc-status">${escapeHtml(status)}${live.ilStatus ? ` · <b>${escapeHtml(live.ilStatus)}</b>` : ""}</span>` +
    `</div></div>` +
    `<div class="pc-tiles">${tiles.map(([v, l]) => `<div class="pc-tile"><b>${v}</b><span>${l}</span></div>`).join("")}</div>` +
    `</div>` +
    `<div class="pc-tabs"><button class="pc-tab on" data-tab="summary">Summary</button>` +
    `<button class="pc-tab" data-tab="log">Game Log</button></div>` +
    `<div class="pc-body">${summaryHTML}</div>` +
    actions;

  const host = openSheet(body);
  const bodyEl = host.querySelector(".pc-body");
  const pitcher = /:P$/.test(String(id)) || (!/:B$/.test(String(id)) && isPitcherPlayer(p));
  host.querySelectorAll(".pc-tab").forEach((t) => t.addEventListener("click", () => {
    host.querySelectorAll(".pc-tab").forEach((x) => x.classList.toggle("on", x === t));
    if (t.dataset.tab === "summary") { bodyEl.innerHTML = summaryHTML; return; }
    bodyEl.innerHTML = `<p class="hint">Loading game log…</p>`;
    loadGameLog(id).then((rows) => { bodyEl.innerHTML = gameLogTable(rows, pitcher); })
      .catch(() => { bodyEl.innerHTML = `<p class="hint">Game log isn't available right now.</p>`; });
  }));
  host.querySelectorAll("[data-card]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.card;
    if (a === "bench" || a === "activate") return benchPlayer(id);
    if (a === "start") { closeSheet(); return openMovePicker(id); }
    if (a === "il") { const slot = IL_KEYS.find((k) => !il[k]); if (!slot) return toast("Your IL is full.", "error"); return moveIntoSlot(id, slot); }
  }));
}

// Game-by-game statlines as a scrollable table (batting or pitching columns).
function gameLogTable(rows, pitcher) {
  const half = pitcher ? "pitching" : "batting";
  const games = (rows || []).filter((r) => r[half]);
  if (!games.length) return `<p class="hint">No ${pitcher ? "pitching" : "batting"} games logged this season yet.</p>`;
  const ip = (p) => p.inningsPitched || (p.outs != null ? `${Math.floor(p.outs / 3)}.${p.outs % 3}` : "0.0");
  const cols = pitcher
    ? ["IP", "H", "ER", "K", "BB", "W", "SV", "HLD"]
    : ["PA", "H", "2B", "3B", "HR", "R", "RBI", "BB", "SB", "K"];
  const cellsFor = (r) => {
    const b = r.batting || {}, p = r.pitching || {};
    return pitcher
      ? [ip(p), p.hits || 0, p.earnedRuns || 0, p.strikeOuts || 0, p.baseOnBalls || 0, p.wins || 0, p.saves || 0, p.holds || 0]
      : [b.plateAppearances || 0, b.hits || 0, b.doubles || 0, b.triples || 0, b.homeRuns || 0,
         b.runs || 0, b.rbi || 0, b.baseOnBalls || 0, b.stolenBases || 0, b.strikeOuts || 0];
  };
  const head = `<tr><th class="ta-left">Date</th><th>PTS</th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;
  const body = games.map((r) => {
    const half2 = pitcher ? Scoring.round1(Scoring.scorePitching(r.pitching)) : Scoring.round1(Scoring.scoreHitting(r.batting));
    return `<tr><td class="ta-left">${fmtDay(r.date)}</td><td class="gl-pts">${half2}</td>` +
      cellsFor(r).map((v) => `<td>${v}</td>`).join("") + `</tr>`;
  }).join("");
  return `<div class="scroll-x gl-wrap"><table class="gl-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
    `<p class="hint">${games.length} game${games.length > 1 ? "s" : ""} · fantasy points by our scoring.</p>`;
}

function setupNotice() {
  return `<div class="card"><h3>Welcome</h3><p class="hint">Firebase isn't configured yet — ` +
    `paste your project config into <code>shared/firebase-init.js</code> (see SETUP.md). ` +
    `Until then the app runs in preview mode with no data.</p></div>`;
}
