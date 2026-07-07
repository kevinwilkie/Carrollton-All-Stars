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

// Yahoo's "Start Active Players": pull bench players with a game today into
// empty active slots, then swap them in for starters who aren't playing.
// Locked players never move; every swap is validated both directions.
function startActivePlayers(slots) {
  const next = { ...slots };
  const active = SLOT_KEYS.filter(isActiveSlot);
  const benchKeys = SLOT_KEYS.filter((k) => slotType(k) === "BN");
  const hasGame = (id) => !!gameFor(playerOf(id));
  const movable = (id) => id && playerOf(id) && !isLockedNow(id, playerOf(id));
  let moves = 0;
  benchKeys.forEach((bk) => {
    const bid = next[bk];
    if (!movable(bid) || !hasGame(bid)) return;
    const bp = playerOf(bid);
    let target = active.find((ak) => !next[ak] && playerFitsSlotKey(bp, ak));
    if (!target) target = active.find((ak) => {
      const oid = next[ak];
      return movable(oid) && !hasGame(oid) && playerFitsSlotKey(bp, ak);
    });
    if (target) {
      const oid = next[target] || null;
      next[target] = bid;
      next[bk] = oid;
      moves++;
    }
  });
  return { next, moves };
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
    const chip = `<span class="slot-chip chip-${t}">${t}</span>`;
    if (!id) {
      return `<div class="lu-row${cls}${selCls}${droppable}" data-slot="${slotKey}">` +
        `${chip}<span class="lu-empty">Empty</span></div>`;
    }
    const p = metaOf(id);
    const live = playerOf(id);
    const locked = isLockedNow(id, playerOf(id));
    const pts = dayPts[String(id)] ? dayPts[String(id)].points : null;
    const ilBad = t === "IL" && live && !live.ilStatus;
    return `<div class="lu-row${cls}${selCls}${droppable}" data-slot="${slotKey}">` +
      chip +
      `<span class="lu-player" data-slot="${slotKey}">${avatarHTML(p, 34)}` +
      `<span class="lu-stack"><span class="lu-name">${escapeHtml(p.name)}</span>` +
      `<span class="lu-meta">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
      `${live && live.ilStatus ? ` <span class="il-flag">${escapeHtml(live.ilStatus)}</span>` : ""}` +
      `${ilBad ? ` <span class="il-flag">⚠ not on MLB IL</span>` : ""}</span>` +
      `${live ? gameLineHTML(live) : `<span class="lu-game none">No game</span>`}</span></span>` +
      `<span class="lu-right"><span class="lu-pts">${pts != null ? pts : "—"}</span>` +
      `${locked ? `<span class="lu-lock">🔒</span>` : ""}</span></div>`;
  };

  const isHitterSlot = (k) => ["C", "1B", "2B", "3B", "SS", "INF", "OF", "UTIL"].includes(slotType(k));
  const batters = SLOT_KEYS.filter((k) => isActiveSlot(k) && isHitterSlot(k));
  const pitchers = SLOT_KEYS.filter((k) => isActiveSlot(k) && !isHitterSlot(k));
  const bench = SLOT_KEYS.filter((k) => slotType(k) === "BN");
  const il = SLOT_KEYS.filter((k) => slotType(k) === "IL");
  const section = (title, keys) =>
    `<div class="sec-head">${title}</div>${keys.map(rowFor).join("")}`;

  // ---- Team summary card (record · rank · owner, week points, shortcuts) ----
  const me = App.teams[App.myTeamId] || {};
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
    (App.date >= today ? `<button class="btn btn-ghost btn-small" id="btn-start-active">⚡ Start active players</button>` : "") +
    `</div>`;

  host.innerHTML =
    card + dateNav +
    (App.selectedSlot
      ? `<p class="hint">Moving <b>${escapeHtml(metaOf(slots[App.selectedSlot]).name || "empty slot")}</b> — tap a highlighted slot, or tap again to cancel.</p>`
      : `<p class="hint">Tap a player, then a highlighted slot, to set your lineup. 🔒 = locked (game started).</p>`) +
    `<div class="lineup-grid">` +
    section("Batters", batters) +
    section("Pitchers", pitchers) +
    section("Bench", bench) +
    section("Injured List", il) +
    `</div>`;

  const go = (days) => {
    App.date = addDays(App.date, days);
    App.selectedSlot = null;
    luScore = null;
    subscribeDay();
    ensureMyTeamData();
  };
  const prev = $("#dn-prev"), next = $("#dn-next");
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
  $("#dn-today").addEventListener("click", () => { if (App.date !== today) go(0), App.date = today, ensureMyTeamData(); });
  host.querySelectorAll(".tc-link").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.goto)));

  const sa = $("#btn-start-active");
  if (sa) sa.addEventListener("click", async () => {
    const { next: filled, moves } = startActivePlayers(slots);
    if (!moves) return toast("Everyone with a game today is already starting.", "success");
    try {
      await saveLineupSlots(filled);
      toast(`Moved ${moves} player${moves > 1 ? "s" : ""} into the lineup.`, "success");
    } catch (e) {
      toast("Couldn't save lineup: " + (e.message || "permission denied"), "error");
    }
    renderActive();
  });

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
