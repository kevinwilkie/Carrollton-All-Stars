/*
 * Season app — shell wiring: tabs, sign-in gate, role handling, dispatch.
 * Loaded last; kicks everything off on DOMContentLoaded.
 */
"use strict";

const RENDERERS = {
  myteam: () => renderMyTeam(),
  matchup: () => renderMatchup(),
  scoreboard: () => renderScoreboard(),
  standings: () => renderStandings(),
  players: () => renderPlayers(),
  trades: () => renderTrades(),
  transactions: () => renderTransactions(),
  schedule: () => renderSchedule(),
  keepers: () => renderKeepers(),
  admin: () => renderAdmin(),
};

function setTab(name) {
  App.tab = name;
  Object.keys(RENDERERS).forEach((t) => {
    const v = $("#view-" + t);
    if (v) v.hidden = t !== name;
  });
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  renderActive();
}

function renderActive() {
  const fn = RENDERERS[App.tab];
  if (fn) { try { fn(); } catch (e) { console.error("render error", e); } }
}

// Topbar pills: current week + my FAAB; role badge.
function renderShell() {
  const wk = currentWeek();
  const wp = $("#week-pill");
  wp.hidden = !wk;
  if (wk) wp.textContent = `Week ${wk.n}${wk.type === "playoff" ? " · Playoffs" : ""}`;
  const fp = $("#faab-pill");
  const faab = App.myTeamId && App.teams[App.myTeamId] ? App.teams[App.myTeamId].faabRemaining : null;
  fp.hidden = faab == null;
  if (faab != null) fp.textContent = `$${faab} FAAB`;
}

function applyRole() {
  const badge = $("#role-badge");
  const authBtn = $("#btn-auth");
  const gate = $("#gate");
  $("#tab-admin").hidden = Auth.role !== "commish";

  if (Auth.role === "local") {
    gate.hidden = true;
    badge.hidden = true;
    authBtn.hidden = true;
    renderActive();
    return;
  }

  if (Auth.role === "guest") {
    gate.hidden = false;
    $("#gate-msg").textContent = Auth.user
      ? `${Auth.user.email} isn't registered to a team in this league. Try another account, or ask the commissioner to add you.`
      : "Sign in with the Google account your team is registered under.";
    $("#gate-signout").hidden = !Auth.user;
    badge.hidden = true;
    authBtn.textContent = "Sign in";
    return;
  }

  // owner / commish
  gate.hidden = true;
  App.myTeamId = Auth.teamId;
  badge.hidden = false;
  if (Auth.role === "commish") {
    badge.textContent = "✎ Commissioner";
    badge.className = "role-badge role-commish";
  } else {
    badge.textContent = teamName(App.myTeamId);
    badge.className = "role-badge role-owner";
  }
  authBtn.textContent = "Sign out";
  subscribeCore();
  renderShell();
  renderActive();
}

document.addEventListener("DOMContentLoaded", () => {
  wireThemeButton($("#btn-theme"));
  trackHeaderHeight();
  $$(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#btn-auth").addEventListener("click", () => {
    if (Auth.user) signOutUser(); else signInGoogle();
  });
  $("#gate-signin").addEventListener("click", signInGoogle);
  $("#gate-signout").addEventListener("click", signOutUser);
  wireClaimModal();
  wireTradeModal();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("#claim-modal").hidden = true; $("#trade-modal").hidden = true; }
  });

  const ok = apiInit();
  if (!ok) {
    Auth.role = "local";
    applyRole();
    return;
  }
  initAuth();
  onAuthRole(() => applyRole());
});
