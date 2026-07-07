/*
 * Transactions tab — the league's append-only activity log (adds, drops,
 * trades, waiver results), written by the scheduled functions.
 */
"use strict";

function renderTransactions() {
  const host = $("#view-transactions");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (!App.transactions.length)
    return host.innerHTML = `<div class="empty-note">No transactions yet.</div>`;

  const line = (tx) => {
    const when = tx.at ? new Date(tx.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    let body = "";
    if (tx.type === "add") body = `<span class="tx-add">＋ ${escapeHtml(tx.name)}</span> → <b>${escapeHtml(teamName(tx.teamId))}</b>` +
      (tx.via === "faab" ? ` <span class="sub" style="display:inline">($${tx.bid} FAAB)</span>` : "");
    else if (tx.type === "drop") body = `<span class="tx-drop">－ ${escapeHtml(tx.name)}</span> dropped by <b>${escapeHtml(teamName(tx.teamId))}</b>`;
    else if (tx.type === "trade") body = `<span class="tx-trade">⇄ ${escapeHtml(tx.name)}</span> ` +
      `<b>${escapeHtml(teamName(tx.fromTeam))}</b> → <b>${escapeHtml(teamName(tx.toTeam))}</b>`;
    else body = `${escapeHtml(tx.type || "event")} ${escapeHtml(tx.name || "")}`;
    return `<div class="row tx-row"><span class="grow">${body}</span><span class="tx-time">${when}</span></div>`;
  };

  host.innerHTML =
    `<div class="view-head"><h2>Transactions</h2></div>` +
    `<div class="card">${App.transactions.map(line).join("")}</div>`;
}
