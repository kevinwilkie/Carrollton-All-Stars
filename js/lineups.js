/*
 * My Team tab — the daily lineup editor.
 * Tap a player, then tap a highlighted destination slot to swap. Players lock
 * at their game's first pitch (the ingest job snapshots locks; the UI also
 * treats any started game as locked so the two never disagree in your favor).
 */
"use strict";

let luRoster = null;       // my roster doc
let luScore = null;        // my score doc for the viewed week
let luLoading = false;

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

function lineupSlotsForView() {
  // Prefer the live doc; otherwise build a preview from the roster (first
  // edit writes it). Past dates without a doc just show empty.
  if (App.lineup && App.lineup.slots) return { ...App.lineup.slots };
  if (!luRoster) return null;
  const players = Object.values(luRoster.players || {}).map((p) => ({
    mlbId: p.mlbId, positions: p.positions || [],
  }));
  const slots = Object.fromEntries(SLOT_KEYS.map((k) => [k, null]));
  const draftKeys = SLOT_KEYS.filter((k) => slotType(k) !== "IL");
  const { cells, overflow } = Feasibility.assignSlots(players);
  cells.forEach((c, i) => { if (c.player) slots[draftKeys[i]] = c.player.mlbId; });
  const ilKeys = SLOT_KEYS.filter((k) => slotType(k) === "IL");
  overflow.forEach((p, i) => { if (ilKeys[i]) slots[ilKeys[i]] = p.mlbId; });
  return slots;
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

function renderMyTeam() {
  const host = $("#view-myteam");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (!App.myTeamId) return host.innerHTML =
    `<div class="card"><h3>My Team</h3><p class="hint">This Google account isn't linked to a team. ` +
    `Ask the commissioner to add your email to the league config.</p></div>`;
  if (!App.players || !luRoster) { ensureMyTeamData(); return host.innerHTML = `<div class="empty-note">Loading roster…</div>`; }

  const slots = lineupSlotsForView();
  const today = etDate();
  const wk = weekFor(App.date);

  // Date strip: yesterday through +7.
  const chips = [];
  for (let i = -1; i <= 7; i++) {
    const d = addDays(today, i);
    chips.push(`<button class="date-chip${d === App.date ? " on" : ""}" data-date="${d}">` +
      `${i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDay(d)}</button>`);
  }

  const dayPts = (luScore && luScore.byPlayerDays && luScore.byPlayerDays[App.date]) || {};
  const dayTotal = (luScore && luScore.byDay && luScore.byDay[App.date]) ?? null;

  const rowFor = (slotKey) => {
    const id = slots ? slots[slotKey] : null;
    const t = slotType(slotKey);
    const cls = t === "BN" ? " bench" : t === "IL" ? " il" : "";
    const selCls = App.selectedSlot === slotKey ? " selected" : "";
    let droppable = "";
    if (App.selectedSlot && App.selectedSlot !== slotKey) {
      const moving = metaOf(slots[App.selectedSlot]);
      const occupant = id ? metaOf(id) : null;
      const fromType = slotType(App.selectedSlot);
      if (slots[App.selectedSlot] && playerFitsSlotKey(playerOf(slots[App.selectedSlot]) || moving, slotKey) &&
          (!occupant || playerFitsSlotKey(playerOf(id) || occupant, fromType === "IL" ? "IL1" : App.selectedSlot)) &&
          (!id || !isLockedNow(id, playerOf(id))) ) {
        droppable = " droppable";
      }
    }
    if (!id) {
      return `<div class="lu-row${cls}${selCls}${droppable}" data-slot="${slotKey}">` +
        `<span class="lu-slot">${slotKey}</span><span class="lu-empty">empty</span></div>`;
    }
    const p = metaOf(id);
    const locked = isLockedNow(id, playerOf(id));
    const g = gameFor(playerOf(id));
    const pts = dayPts[String(id)] ? dayPts[String(id)].points : null;
    const ilBad = t === "IL" && playerOf(id) && !playerOf(id).ilStatus;
    return `<div class="lu-row${cls}${selCls}${droppable}" data-slot="${slotKey}">` +
      `<span class="lu-slot">${slotKey}</span>` +
      `<span class="lu-player" data-slot="${slotKey}">${avatarHTML(p, 28)}` +
      `<span class="lu-stack"><span class="lu-name">${escapeHtml(p.name)}</span>` +
      `<span class="lu-meta">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
      `${playerOf(id) && playerOf(id).ilStatus ? ` <span class="il-flag">${escapeHtml(playerOf(id).ilStatus)}</span>` : ""}` +
      `${ilBad ? ` <span class="il-flag">⚠ not on MLB IL</span>` : ""}</span></span></span>` +
      `<span class="lu-time">${g ? (g.status === "Final" ? "Final" : g.firstPitchUTC ? fmtTimeET(g.firstPitchUTC) : "") : "no game"}</span>` +
      `<span class="lu-pts">${pts != null ? pts : "—"}</span>` +
      `<span class="lu-lock">${locked ? "🔒" : ""}</span></div>`;
  };

  const starters = SLOT_KEYS.filter((k) => isActiveSlot(k));
  const bench = SLOT_KEYS.filter((k) => slotType(k) === "BN");
  const il = SLOT_KEYS.filter((k) => slotType(k) === "IL");

  const startsUsed = luScore && luScore.startsUsed != null ? luScore.startsUsed : null;
  host.innerHTML =
    `<div class="view-head"><h2>${escapeHtml(teamName(App.myTeamId))}</h2><span>` +
    (startsUsed != null
      ? `<span class="pill${startsUsed >= PITCHING.maxStartsPerWeek ? " pill-warn" : ""}" ` +
        `title="Only ${PITCHING.maxStartsPerWeek} pitcher starts count per week">` +
        `${startsUsed}/${PITCHING.maxStartsPerWeek} SP starts</span> `
      : "") +
    `<span class="pill">${wk ? `Week ${wk.n}` : "off-season"}${dayTotal != null ? ` · ${dayTotal} pts ${fmtDay(App.date)}` : ""}</span></span></div>` +
    `<div class="date-strip">${chips.join("")}</div>` +
    (App.selectedSlot
      ? `<p class="hint">Moving <b>${escapeHtml(metaOf(slots[App.selectedSlot]).name || "empty slot")}</b> — tap a highlighted slot, or tap again to cancel.</p>`
      : `<p class="hint">Tap a player, then a highlighted slot, to set your lineup. 🔒 = locked (game started).</p>`) +
    `<div class="lineup-grid">${starters.map(rowFor).join("")}` +
    `<div class="divider-thin"></div>${bench.map(rowFor).join("")}` +
    `<div class="divider-thin"></div>${il.map(rowFor).join("")}</div>`;

  host.querySelectorAll(".date-chip").forEach((b) =>
    b.addEventListener("click", () => {
      App.date = b.dataset.date;
      App.selectedSlot = null;
      luScore = null;
      subscribeDay();
      ensureMyTeamData();
    }));

  host.querySelectorAll(".lu-row").forEach((row) =>
    row.addEventListener("click", () => onSlotTap(row.dataset.slot, slots)));
}

async function onSlotTap(slotKey, slots) {
  if (App.date < etDate()) return;
  const id = slots[slotKey];

  if (!App.selectedSlot) {
    if (!id) return;
    if (isLockedNow(id, playerOf(id))) return toast(`${metaOf(id).name} is locked for ${fmtDay(App.date)}.`, "error");
    App.selectedSlot = slotKey;
    return renderActive();
  }
  if (App.selectedSlot === slotKey) {
    App.selectedSlot = null;
    return renderActive();
  }

  // Swap selected → tapped.
  const fromKey = App.selectedSlot;
  const movingId = slots[fromKey];
  const occupantId = slots[slotKey];
  const moving = playerOf(movingId) || metaOf(movingId);
  const occupant = occupantId ? (playerOf(occupantId) || metaOf(occupantId)) : null;

  if (!playerFitsSlotKey(moving, slotKey))
    return toast(`${moving.name} can't fill ${slotKey}${slotType(slotKey) === "IL" ? " (not on an MLB IL)" : ""}.`, "error");
  if (occupant && isLockedNow(occupantId, playerOf(occupantId)))
    return toast(`${occupant.name} is locked.`, "error");
  if (occupant && !playerFitsSlotKey(occupant, fromKey))
    return toast(`${occupant.name} can't move to ${fromKey}.`, "error");

  const next = { ...slots, [slotKey]: movingId, [fromKey]: occupantId || null };
  App.selectedSlot = null;
  try {
    await saveLineupSlots(next);
    toast("Lineup saved.", "success");
  } catch (e) {
    toast("Couldn't save lineup: " + (e.message || "permission denied"), "error");
  }
  renderActive();
}

function setupNotice() {
  return `<div class="card"><h3>Welcome</h3><p class="hint">Firebase isn't configured yet — ` +
    `paste your project config into <code>shared/firebase-init.js</code> (see SETUP.md). ` +
    `Until then the app runs in preview mode with no data.</p></div>`;
}
