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
  } finally { kpLoading = false; }
  renderActive();
}

function keeperCostOf(p) {
  // via draft/keeper at $X → next year $X+5; via faab/undrafted → flat $5.
  if (p.via === "faab") return { cost: KEEPER.undraftedPrice, formula: `FAAB pickup → flat $${KEEPER.undraftedPrice}` };
  const yearsKept = p.via === "keeper" ? 1 : 0; // kept this season already?
  if (yearsKept >= 1) return { cost: null, formula: "Year 2 → ESPN avg salary at the deadline" };
  return { cost: (p.price || 0) + KEEPER.y1Inflation, formula: `$${p.price || 0} + $${KEEPER.y1Inflation}` };
}

function renderKeepers() {
  const host = $("#view-keepers");
  if (!App.fs) return host.innerHTML = setupNotice();
  if (!App.myTeamId) return host.innerHTML = `<div class="empty-note">Sign in with a team account to manage keepers.</div>`;
  if (!kpRoster) { ensureKeeperData(); return host.innerHTML = `<div class="empty-note">Loading…</div>`; }

  const declared = new Set(((kpDecl && kpDecl.entries) || []).map((e) => String(e.mlbId)));
  const players = Object.values(kpRoster.players || {})
    .sort((a, b) => (b.price || 0) - (a.price || 0));

  const rows = players.map((p) => {
    const k = keeperCostOf(p);
    const on = declared.has(String(p.mlbId));
    const wasKept = p.via === "keeper";
    return `<div class="row keeper-row">${avatarHTML(p, 30)}` +
      `<span class="grow"><span class="pl-name">${escapeHtml(p.name)}` +
      `${wasKept ? ` <span class="kept-badge y2" style="border:1px solid var(--gold);color:var(--gold);border-radius:999px;font-size:10px;padding:1px 7px">kept this yr</span>` : ""}</span>` +
      `<span class="sub">${(p.positions || []).join("/")} · acquired via ${escapeHtml(p.via || "draft")} ($${p.price || 0})` +
      ` · ${escapeHtml(k.formula)}</span></span>` +
      `<span class="cost">${k.cost != null ? "$" + k.cost : "ESPN avg"}</span>` +
      `<button class="btn btn-small btn-ghost keeper-declare${on ? " on" : ""}" data-keep="${p.mlbId}" data-name="${escapeHtml(p.name)}">` +
      `${on ? "✓ Keeping" : "Keep"}</button></div>`;
  }).join("") || `<div class="empty-note">No players on your roster yet.</div>`;

  host.innerHTML =
    `<div class="view-head"><h2>Keepers · ${LEAGUE.season + 1}</h2>` +
    `<span class="pill${declared.size > KEEPER.max ? " pill-bad" : ""}">${declared.size}/${KEEPER.max} declared</span></div>` +
    `<p class="hint">Declare up to ${KEEPER.max} keepers for next season. Year 1 = this year's price + $${KEEPER.y1Inflation} ` +
    `($${KEEPER.undraftedPrice} for pickups); Year 2 = ESPN average salary, and it's the final year. ` +
    `Deadline: ${KEEPER.espnDeadline}.</p>` +
    `<div class="card">${rows}</div>`;

  host.querySelectorAll("[data-keep]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.keep;
      const next = new Set(declared);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= KEEPER.max) return toast(`Max ${KEEPER.max} keepers.`, "error");
        next.add(id);
      }
      const entries = [...next].map((mlbId) => {
        const p = Object.values(kpRoster.players).find((x) => String(x.mlbId) === mlbId);
        const k = p ? keeperCostOf(p) : { cost: null };
        return { mlbId: +mlbId, name: p ? p.name : "", price: p ? p.price || 0 : 0, plannedCost: k.cost };
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
