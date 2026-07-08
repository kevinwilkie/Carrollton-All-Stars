/*
 * Keepers tab — next season's keeper picture for my roster:
 *   Year 1 price = this year's price + $5 ($5 for FAAB pickups)
 *   Year 2 price = ESPN average salary at the deadline (final year)
 * Owners can declare up to 5 before the deadline; the declaration is stored in
 * Firestore and pre-loads the draft board next spring.
 */
"use strict";

let kpRoster = null;
let kpDecl = null;
let kpLoading = false;

async function ensureKeeperData() {
  if (kpLoading || !App.myTeamId) return;
  kpLoading = true;
  try {
    kpRoster = await loadRoster(App.myTeamId, true);
    kpDecl = await loadKeeperDeclaration(LEAGUE.season + 1);
  } catch (e) {
    kpLoading = false;
    return dataError("keepers", e);
  } finally { kpLoading = false; }
  renderActive();
}

// Consecutive seasons this player has ALREADY been kept (incl. this one). Set
// when keepers are applied at the draft; fall back to inferring 1 from a
// `via:"keeper"` acquisition for rosters that predate the counter.
function keptYearsOf(p) {
  return p.keeperYears != null ? p.keeperYears : (p.via === "keeper" ? 1 : 0);
}

function keeperCostOf(p) {
  const ky = keptYearsOf(p);
  if (ky >= 2) return { eligible: false, cost: null, formula: "Kept 2 straight years — not eligible" };
  if (ky >= 1) return { eligible: true, cost: null, formula: "Year 2 → ESPN avg salary at the deadline (final year)" };
  if (p.via === "faab" || p.via === "undrafted")
    return { eligible: true, cost: KEEPER.undraftedPrice, formula: `Pickup → flat $${KEEPER.undraftedPrice}` };
  return { eligible: true, cost: (p.price || 0) + KEEPER.y1Inflation, formula: `Year 1 → $${p.price || 0} + $${KEEPER.y1Inflation}` };
}

function renderKeepers() {
  const host = $("#view-keepers");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (!App.myTeamId) return host.innerHTML = `<div class="empty-note">Sign in with a team account to manage keepers.</div>`;
  if (App.errors.keepers) return host.innerHTML = errorCard("keepers");
  if (!kpRoster) { ensureKeeperData(); return host.innerHTML = `<div class="empty-note">Loading…</div>`; }

  const declared = new Set(((kpDecl && kpDecl.entries) || []).map((e) => String(e.mlbId)));
  const declSeason = LEAGUE.season + 1;            // the tab declares NEXT season's keepers
  const deadline = `${declSeason}-${KEEPER.deadlineMonthDay || "03-14"}`; // ~a week before that draft
  const locked = etDate() > deadline;              // freezes at next season's deadline, not this draft's
  const players = Object.values(kpRoster.players || {})
    .sort((a, b) => (b.price || 0) - (a.price || 0));
  // Running keeper commitment against next year's auction budget.
  const declaredPlayers = players.filter((p) => declared.has(String(p.mlbId)));
  let keeperSpend = 0, keeperTbd = 0;
  declaredPlayers.forEach((p) => {
    const c = keeperCostOf(p);
    if (c.cost != null) keeperSpend += c.cost; else if (c.eligible) keeperTbd++;
  });

  const rows = players.map((p) => {
    const k = keeperCostOf(p);
    const on = declared.has(String(p.mlbId));
    const ky = keptYearsOf(p);
    const badge = ky >= 2
      ? `<span class="kept-badge" style="border:1px solid var(--bad);color:var(--bad);border-radius:999px;font-size:10px;padding:1px 7px">ineligible</span>`
      : ky === 1
        ? `<span class="kept-badge" style="border:1px solid var(--gold);color:var(--gold);border-radius:999px;font-size:10px;padding:1px 7px">Y2 next</span>`
        : "";
    const disabled = !k.eligible || locked || (!on && declared.size >= KEEPER.max);
    const label = !k.eligible ? "Not eligible" : on ? "✓ Keeping" : "Keep";
    return `<div class="row keeper-row${!k.eligible ? " dim" : ""}">${avatarHTML(p, 30)}` +
      `<span class="grow"><span class="pl-name">${escapeHtml(p.name)} ${badge}</span>` +
      `<span class="sub">${(p.positions || []).join("/")} · via ${escapeHtml(p.via || "draft")} ($${p.price || 0})` +
      ` · ${escapeHtml(k.formula)}</span></span>` +
      `<span class="cost">${k.cost != null ? "$" + k.cost : k.eligible ? "~ESPN avg" : "—"}</span>` +
      `<button class="btn btn-small btn-ghost keeper-declare${on ? " on" : ""}" ${disabled ? "disabled" : ""} ` +
      `data-keep="${p.mlbId}">${label}</button></div>`;
  }).join("") || `<div class="empty-note">No players on your roster yet.</div>`;

  const budgetLine =
    `<p class="hint">Keeper commitment: <b>$${keeperSpend}</b> of the $${BUDGET} auction budget` +
    (keeperTbd ? ` · plus ${keeperTbd} at ~ESPN avg (set at the ${declSeason} draft)` : "") + `.</p>`;
  host.innerHTML =
    `<div class="view-head"><h2>Keepers · ${declSeason}</h2>` +
    `<span class="pill${declared.size > KEEPER.max ? " pill-bad" : ""}">${declared.size}/${KEEPER.max} declared</span></div>` +
    `<p class="hint">Declare up to ${KEEPER.max} keepers for the ${declSeason} season. Year 1 = this year's price + $${KEEPER.y1Inflation} ` +
    `($${KEEPER.undraftedPrice} for pickups); Year 2 = ESPN average salary (final year — no 3rd straight). ` +
    `Deadline: ${deadline}.</p>` +
    budgetLine +
    (locked ? `<p class="hint" style="color:var(--warn)">🔒 The ${deadline} deadline has passed — declarations are locked.</p>` : "") +
    `<div class="card">${rows}</div>`;

  host.querySelectorAll("[data-keep]:not([disabled])").forEach((b) =>
    b.addEventListener("click", async () => {
      if (locked) return toast("The keeper deadline has passed.", "error");
      const id = b.dataset.keep;
      const p = Object.values(kpRoster.players).find((x) => String(x.mlbId) === id);
      const next = new Set(declared);
      if (next.has(id)) next.delete(id);
      else {
        if (p && !keeperCostOf(p).eligible) return toast(`${p.name} can't be kept a 3rd straight year.`, "error");
        if (next.size >= KEEPER.max) return toast(`Max ${KEEPER.max} keepers.`, "error");
        next.add(id);
      }
      const entries = [...next].map((mlbId) => {
        const pp = Object.values(kpRoster.players).find((x) => String(x.mlbId) === mlbId);
        const k = pp ? keeperCostOf(pp) : { cost: null };
        return { mlbId, name: pp ? pp.name : "", price: pp ? pp.price || 0 : 0,
          keptYears: pp ? keptYearsOf(pp) : 0, plannedCost: k.cost };
      });
      try {
        await saveKeeperDeclaration(LEAGUE.season + 1, entries);
        kpDecl = { entries };
        toast("Keeper declaration saved.", "success");
      } catch (e) {
        toast("Couldn't save: " + (e.message || "permission denied"), "error");
      }
      renderActive();
    }));
}
