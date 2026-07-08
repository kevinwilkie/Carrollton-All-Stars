/*
 * Players tab — the free-agent pool. Everything unrostered is acquired through
 * daily FAAB waivers ($1 minimum, processed ~3am ET, ties → worse record).
 */
"use strict";

let plFilter = { q: "", pos: "ALL", avail: "available" };
let plClaimTarget = null;

function renderPlayers() {
  const host = $("#view-players");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (App.errors.players) return host.innerHTML = errorCard("players");
  if (!App.players) {
    loadPlayers().then(renderActive).catch((e) => dataError("players", e));
    return host.innerHTML = `<div class="empty-note">Loading players…</div>`;
  }

  const POS = ["ALL", "C", "1B", "2B", "3B", "SS", "OF", "DH", "SP", "RP"];
  const seg = POS.map((p) =>
    `<button class="segbtn${plFilter.pos === p ? " on" : ""}" data-pos="${p}">${p === "ALL" ? "All" : p}</button>`).join("");

  const faab = (App.teams[App.myTeamId] || {}).faabRemaining;

  const myClaims = App.claims.filter((c) => c.status === "pending");
  const claimRows = myClaims.map((c) =>
    `<div class="row"><span class="grow"><b class="tx-add">+ ${escapeHtml(c.addName)}</b>` +
    `${c.drop ? ` <span class="sub">dropping ${escapeHtml(dropNameOf(c.drop))}</span>` : ""}` +
    `<span class="sub">processes ${fmtDay(c.forDate)} ~3am ET</span></span>` +
    `<span class="val">$${c.bid}</span>` +
    `<button class="btn btn-danger-ghost btn-small" data-cancel="${c.id}">Cancel</button></div>`).join("");

  const resolved = App.claims.filter((c) => c.status !== "pending").slice(0, 8);
  const resolvedRows = resolved.map((c) =>
    `<div class="row dim"><span class="grow">${c.status === "won" ? "✅" : "❌"} ${escapeHtml(c.addName)}` +
    ` <span class="sub">${escapeHtml(c.resolvedNote || c.status)}</span></span><span class="val">$${c.bid}</span></div>`).join("");

  host.innerHTML =
    `<div class="view-head"><h2>Players</h2>` +
    (faab != null ? `<span class="pill pill-live">$${faab} FAAB left</span>` : "") + `</div>` +
    `<div class="players-filters">` +
    `<input type="search" id="pl-search" placeholder="Search players…" value="${escapeHtml(plFilter.q)}" style="flex:1;min-width:170px" />` +
    `<span class="seg">${seg}</span>` +
    `<span class="seg">` +
    ["available", "all", "rostered"].map((a) =>
      `<button class="segbtn${plFilter.avail === a ? " on" : ""}" data-avail="${a}">${a[0].toUpperCase() + a.slice(1)}</button>`).join("") +
    `</span></div>` +
    `<div id="pl-results">${playersListHTML()}</div>` +
    (myClaims.length || resolved.length
      ? `<div class="card claims-pending"><h3>My waiver claims</h3>${claimRows}${resolvedRows}</div>` : "");

  // Typing must NOT re-render the whole tab — that recreates #pl-search and
  // drops focus after a single character. Refresh only the results list.
  const search = $("#pl-search");
  search.addEventListener("input", () => { plFilter.q = search.value; refreshPlayerList(); });
  host.querySelectorAll("[data-pos]").forEach((b) =>
    b.addEventListener("click", () => { plFilter.pos = b.dataset.pos; renderPlayers(); }));
  host.querySelectorAll("[data-avail]").forEach((b) =>
    b.addEventListener("click", () => { plFilter.avail = b.dataset.avail; renderPlayers(); }));
  wirePlayerResultButtons($("#pl-results"));
  host.querySelectorAll("[data-cancel]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await cancelClaim(b.dataset.cancel); toast("Claim cancelled.", "success"); }
      catch (e) { toast("Couldn't cancel: " + (e.message || ""), "error"); }
    }));
}

// Filter + sort the pool by the current filters. Best fantasy producers first —
// the useful order for waiver decisions.
function playersFiltered() {
  let list = App.playersArr;
  if (plFilter.avail === "available") list = list.filter((p) => !p.rosteredBy);
  if (plFilter.avail === "rostered") list = list.filter((p) => p.rosteredBy);
  if (plFilter.pos !== "ALL") list = list.filter((p) => (p.positions || []).includes(plFilter.pos));
  const q = plFilter.q.trim().toLowerCase();
  if (q) list = list.filter((p) => (p.name || "").toLowerCase().includes(q));
  return list.slice().sort((a, b) =>
    (b.seasonPoints || 0) - (a.seasonPoints || 0) || (a.name || "").localeCompare(b.name || ""));
}

// Just the results card (+ "showing top N" note) — rebuilt on every keystroke.
function playersListHTML() {
  const CAP = 300;
  const all = playersFiltered();
  const total = all.length;
  const rows = all.slice(0, CAP).map((p) => {
    const owned = p.rosteredBy;
    const sp = p.seasonPoints;
    return `<div class="row">` +
      `<span class="grow pl-tap" data-card="${p.mlbId}" style="display:flex;align-items:center;gap:10px;cursor:pointer;min-width:0">` +
      `${avatarHTML(p, 30)}<span style="min-width:0"><span class="pl-name">${escapeHtml(p.name)}</span>` +
      `<span class="sub pl-badges">${posBadges(p.positions, "sm")} ${escapeHtml(p.mlbTeam || "")}` +
      `${p.ilStatus ? ` <span class="pl-il">${escapeHtml(p.ilStatus)}</span>` : ""}</span></span></span>` +
      `<span class="val" title="Season fantasy points">${sp != null ? sp : "—"}</span>` +
      (owned
        ? `<span class="pl-owner">${escapeHtml(teamName(owned))}</span>`
        : App.myTeamId
          ? `<button class="btn btn-small" data-claim="${p.mlbId}">+ Claim</button>`
          : "") +
      `</div>`;
  }).join("") || `<div class="empty-note">No players match.</div>`;
  const moreNote = total > CAP
    ? `<div class="empty-note">Showing the top ${CAP} of ${total} by season points — search to narrow.</div>` : "";
  return `<div class="card player-list">${rows}</div>${moreNote}`;
}

function refreshPlayerList() {
  const c = $("#pl-results");
  if (!c) return;
  c.innerHTML = playersListHTML();
  wirePlayerResultButtons(c);
}

function wirePlayerResultButtons(scope) {
  scope.querySelectorAll("[data-card]").forEach((b) =>
    b.addEventListener("click", () => openPlayerCard(b.dataset.card)));
  scope.querySelectorAll("[data-claim]").forEach((b) =>
    b.addEventListener("click", () => openClaim(b.dataset.claim)));
}

function dropNameOf(mlbId) {
  const p = playerOf(mlbId);
  if (p) return p.name;
  const r = App.rosters[App.myTeamId];
  const e = r && r.players && r.players[String(mlbId)];
  return e ? e.name : "#" + mlbId;
}

async function openClaim(mlbId) {
  plClaimTarget = playerOf(mlbId);
  if (!plClaimTarget) return;
  const roster = await loadRoster(App.myTeamId, true);
  const count = Object.keys(roster.players || {}).length;
  const mustDrop = count >= ROSTER_SIZE + IL_SLOTS;

  $("#claim-player").innerHTML = avatarHTML(plClaimTarget, 44) +
    `<div><b>${escapeHtml(plClaimTarget.name)}</b><div class="sub">` +
    `${posBadges(plClaimTarget.positions, "sm")} ${escapeHtml(plClaimTarget.mlbTeam || "")}</div></div>`;
  const dropSel = $("#claim-drop");
  dropSel.innerHTML = `<option value="">— no drop —${mustDrop ? " (roster full!)" : ""}</option>`;
  Object.values(roster.players || {})
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((p) => dropSel.add(new Option(`${p.name} (${(p.positions || []).join("/")})`, p.mlbId)));
  $("#claim-bid").value = 1;
  const faab = (App.teams[App.myTeamId] || {}).faabRemaining ?? FAAB.budget;
  $("#claim-hint").textContent =
    `You have $${faab} FAAB. Processes ${fmtDay(claimProcessDate())} around 3am ET — highest bid wins, ties go to the worse record.` +
    (mustDrop ? " Your roster is full, so pick a player to drop." : "");
  $("#claim-error").hidden = true;
  $("#claim-modal").hidden = false;
}

function wireClaimModal() {
  $("#claim-cancel").addEventListener("click", () => { $("#claim-modal").hidden = true; });
  $("#claim-modal").addEventListener("click", (e) => { if (e.target.id === "claim-modal") $("#claim-modal").hidden = true; });
  $("#claim-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bid = parseInt($("#claim-bid").value, 10);
    const drop = $("#claim-drop").value || null;
    const err = (m) => { const el = $("#claim-error"); el.textContent = m; el.hidden = false; };
    const faab = (App.teams[App.myTeamId] || {}).faabRemaining ?? FAAB.budget;
    if (!Number.isInteger(bid) || bid < FAAB.minBid) return err(`Bid must be at least $${FAAB.minBid}.`);
    if (bid > faab) return err(`You only have $${faab} FAAB left.`);
    const roster = App.rosters[App.myTeamId] || { players: {} };
    if (!drop && Object.keys(roster.players || {}).length >= ROSTER_SIZE + IL_SLOTS)
      return err("Roster full — pick a player to drop.");
    try {
      await placeClaim(plClaimTarget, bid, drop);
      $("#claim-modal").hidden = true;
      toast(`Claim placed: ${plClaimTarget.name} for $${bid}.`, "success");
    } catch (e2) {
      err("Couldn't place claim: " + (e2.message || "permission denied"));
    }
  });
}
