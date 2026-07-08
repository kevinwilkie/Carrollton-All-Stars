/*
 * Trades tab — propose, accept/reject, league veto window, history.
 * Flow: proposed → (recipient accepts) → accepted [24h review, 6 vetoes kill]
 * → executed by the hourly job (or vetoed). Commissioner can override in Admin.
 */
"use strict";

let trGives = new Set();
let trGets = new Set();
let trMineCount = 0, trTheirCount = 0;   // current roster sizes (for the cap check)
const TRADE_MAX = ROSTER_SIZE + IL_SLOTS;

function renderTrades() {
  const host = $("#view-trades");
  if (!App.fs) return host.innerHTML = setupNotice();

  const mine = (t) => t.from === App.myTeamId || t.to === App.myTeamId;
  const pending = App.trades.filter((t) => ["proposed", "accepted"].includes(t.status))
    .sort((a, b) => (b.proposedAt || "").localeCompare(a.proposedAt || ""));
  const history = App.trades.filter((t) => !["proposed", "accepted"].includes(t.status))
    .sort((a, b) => (b.resolvedAt || b.respondedAt || b.proposedAt || "").localeCompare(a.resolvedAt || a.respondedAt || a.proposedAt || ""))
    .slice(0, 12);

  const nameList = (ids) => (ids || []).map((id) => {
    const p = playerOf(id);
    return escapeHtml(p ? p.name : "#" + id);
  }).join(", ") || "—";

  const card = (t) => {
    const vetoes = Object.entries(t.vetoes || {})
      .filter(([team, v]) => v && team !== t.from && team !== t.to).length;
    const involved = t.from === App.myTeamId || t.to === App.myTeamId;
    const myVeto = !!(t.vetoes || {})[App.myTeamId];
    let actions = "";
    if (t.status === "proposed" && t.to === App.myTeamId)
      actions = `<button class="btn btn-small" data-accept="${t.id}">Accept</button>` +
                `<button class="btn btn-danger-ghost btn-small" data-reject="${t.id}">Reject</button>`;
    if (t.status === "proposed" && t.from === App.myTeamId)
      actions = `<button class="btn btn-ghost btn-small" data-withdraw="${t.id}">Withdraw</button>`;
    if (t.status === "accepted" && !involved && App.myTeamId)
      actions = `<button class="btn ${myVeto ? "" : "btn-ghost"} btn-small" data-veto="${t.id}" data-on="${myVeto ? "" : "1"}">` +
        `${myVeto ? "✓ Vetoed — undo" : "Veto"}</button>`;
    const review = t.status === "accepted" && t.reviewEndsAt
      ? `<span class="pill pill-warn countdown">review ends ${new Date(t.reviewEndsAt).toLocaleString()} · vetoes ${vetoes}/${TRADE.vetoesNeeded}</span>`
      : "";
    const statusPill = { proposed: "pill", accepted: "pill pill-warn", executed: "pill pill-live",
      vetoed: "pill pill-bad", rejected: "pill pill-bad", withdrawn: "pill", failed: "pill pill-bad" }[t.status] || "pill";
    return `<div class="card${involved ? " is-me" : ""}">` +
      `<div class="trade-card-row"><b>${escapeHtml(teamName(t.from))}</b> ⇄ <b>${escapeHtml(teamName(t.to))}</b>` +
      `<span class="${statusPill}">${t.status}</span>${review}<span style="margin-left:auto">${actions}</span></div>` +
      `<div class="trade-players"><b>${escapeHtml(teamName(t.from))}</b> sends: ${nameList(t.gives)}</div>` +
      `<div class="trade-players"><b>${escapeHtml(teamName(t.to))}</b> sends: ${nameList(t.gets)}</div>` +
      (t.resolvedNote ? `<div class="sub">${escapeHtml(t.resolvedNote)}</div>` : "") +
      `</div>`;
  };

  host.innerHTML =
    `<div class="view-head"><h2>Trades</h2>` +
    (App.myTeamId ? `<button class="btn" id="btn-propose">+ Propose trade</button>` : "") + `</div>` +
    `<p class="hint">Accepted trades wait ${TRADE.reviewHours} hours; ${TRADE.vetoesNeeded} vetoes from the ${LEAGUE_TEAMS.length - 2} uninvolved owners block it.</p>` +
    `<div class="stack">` +
    (pending.length ? pending.map(card).join("") : `<div class="empty-note">No pending trades.</div>`) +
    (history.length ? `<div class="divider-rule">History</div>` + history.map(card).join("") : "") +
    `</div>`;

  if (!App.players) loadPlayers().then(renderActive);

  const bp = $("#btn-propose");
  if (bp) bp.addEventListener("click", openTradeModal);
  host.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", () => actTrade(() => respondTrade(b.dataset.accept, true), "Trade accepted — the 24-hour league review has started.")));
  host.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => actTrade(() => respondTrade(b.dataset.reject, false), "Trade rejected.")));
  host.querySelectorAll("[data-withdraw]").forEach((b) => b.addEventListener("click", () => actTrade(() => withdrawTrade(b.dataset.withdraw), "Trade withdrawn.")));
  host.querySelectorAll("[data-veto]").forEach((b) => b.addEventListener("click", () => actTrade(() => vetoTrade(b.dataset.veto, !!b.dataset.on), b.dataset.on ? "Veto recorded." : "Veto removed.")));
}

async function actTrade(fn, okMsg) {
  try { await fn(); toast(okMsg, "success"); }
  catch (e) { toast("Action failed: " + (e.message || "permission denied"), "error"); }
}

async function openTradeModal() {
  trGives = new Set(); trGets = new Set();
  const sel = $("#trade-partner");
  sel.innerHTML = "";
  LEAGUE_TEAMS.filter((t) => t.id !== App.myTeamId)
    .forEach((t) => sel.add(new Option(t.name, t.id)));
  await refreshTradeLists();
  $("#trade-error").hidden = true;
  $("#trade-modal").hidden = false;
}

async function refreshTradeLists() {
  const partner = $("#trade-partner").value;
  const [mine, theirs] = await Promise.all([
    loadRoster(App.myTeamId, true), loadRoster(partner, true),
  ]);
  trMineCount = Object.keys(mine.players || {}).length;
  trTheirCount = Object.keys(theirs.players || {}).length;
  const list = (rosterDoc, chosen, attr) =>
    Object.values(rosterDoc.players || {})
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((p) => `<div class="trade-pick${chosen.has(String(p.mlbId)) ? " on" : ""}" data-${attr}="${p.mlbId}">` +
        `${avatarHTML(p, 24)}<span class="grow">${escapeHtml(p.name)}</span>` +
        `<span class="sub">${(p.positions || []).join("/")}</span></div>`).join("") ||
      `<div class="empty-note">Empty roster.</div>`;
  $("#trade-gives").innerHTML = list(mine, trGives, "give");
  $("#trade-gets").innerHTML = list(theirs, trGets, "get");
  $("#trade-gives").querySelectorAll("[data-give]").forEach((el) =>
    el.addEventListener("click", () => { togg(trGives, el.dataset.give); refreshTradeLists(); }));
  $("#trade-gets").querySelectorAll("[data-get]").forEach((el) =>
    el.addEventListener("click", () => { togg(trGets, el.dataset.get); refreshTradeLists(); }));
}
function togg(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function wireTradeModal() {
  $("#trade-cancel").addEventListener("click", () => { $("#trade-modal").hidden = true; });
  $("#trade-modal").addEventListener("click", (e) => { if (e.target.id === "trade-modal") $("#trade-modal").hidden = true; });
  $("#trade-partner").addEventListener("change", () => { trGives.clear(); trGets.clear(); refreshTradeLists(); });
  $("#trade-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (m) => { const el = $("#trade-error"); el.textContent = m; el.hidden = false; };
    if (!trGives.size && !trGets.size) return err("Pick at least one player on either side.");
    // Uneven trades change roster sizes — block anything that would leave
    // either side over the 30-player cap (the server enforces this too).
    const myAfter = trMineCount - trGives.size + trGets.size;
    const theirAfter = trTheirCount - trGets.size + trGives.size;
    if (myAfter > TRADE_MAX) return err(`This would put your roster at ${myAfter}/${TRADE_MAX}. Send more or receive fewer.`);
    if (theirAfter > TRADE_MAX) return err(`This would put ${teamName($("#trade-partner").value)} at ${theirAfter}/${TRADE_MAX}.`);
    try {
      await proposeTrade($("#trade-partner").value, [...trGives], [...trGets]);
      $("#trade-modal").hidden = true;
      toast("Trade proposed.", "success");
    } catch (e2) {
      err("Couldn't propose: " + (e2.message || "permission denied"));
    }
  });
}
