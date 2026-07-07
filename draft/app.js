/*
 * Carrollton All-Stars — Auction Draft Board
 * ---------------------------------------------------------------------------
 * Ported from the League of Dreams board (NFL) to MLB. Vanilla JS, no build.
 * Reads page globals from ../shared/league-config.js (LEAGUE, LEAGUE_TEAMS,
 * BUDGET, ROSTER_SIZE, KEEPER, FAAB, COMMISH_EMAILS), ../shared/util.js,
 * data/mlb-teams.js (TEAMS, DRAFT_ORDER, TEAM_COLORS), data/draft-config.js
 * (SYNC_PATH, POSITION_ORDER, ESPN_*), data/players.js (PLAYERS),
 * data/prior-season.js (PRIOR_SEASON), and feasibility.js (Feasibility).
 *
 * The hat twist: an MLB club is drawn from the hat; only that club's players
 * are nominated until it has no pool players left, then the next club is up.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers
  const TEAM_BY_ABBR = Object.fromEntries(TEAMS.map((t) => [t.abbr, t]));
  const MANAGERS = LEAGUE_TEAMS.map((t) => t.name);
  const playerKey = (p) => (p.id ? String(p.id) : `custom:${p.name}|${p.team}`);
  const positionsOf = (p) => p.positions || (p.pos ? [p.pos] : []);
  const primaryPos = (p) => positionsOf(p)[0] || "DH";
  const teamLogoUrl = (abbr) => {
    const t = TEAM_BY_ABBR[abbr];
    return t ? `https://www.mlbstatic.com/team-logos/${t.id}.svg` : "";
  };

  // ----- club color theming (Draft Board tab) -----
  const TEAM_COLOR_FALLBACK = { primary: "#262b3b", secondary: "#333a4d" };
  function hexLum(hex) {
    const c = (hex || "").replace("#", "");
    if (c.length < 6) return 0;
    const v = (i) => parseInt(c.slice(i, i + 2), 16) / 255;
    const f = (x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    return 0.2126 * f(v(0)) + 0.7152 * f(v(2)) + 0.0722 * f(v(4));
  }
  const onColor = (hex) => (hexLum(hex) > 0.5 ? "#0e1116" : "#ffffff");
  function teamAccent(c) {
    const cands = [c.primary, c.secondary, c.alt].filter(Boolean);
    for (const x of cands) { const L = hexLum(x); if (L >= 0.18 && L <= 0.85) return x; }
    for (const x of cands) { if (hexLum(x) >= 0.12) return x; }
    return cands[0] || "#888888";
  }
  function applyTeamTheme(abbr) {
    const board = document.querySelector(".panel-board");
    if (!board) return;
    const c = (typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[abbr]) || TEAM_COLOR_FALLBACK;
    const acc = teamAccent(c);
    board.style.setProperty("--team-primary", c.primary);
    board.style.setProperty("--team-secondary", c.secondary || c.primary);
    board.style.setProperty("--team-on-primary", onColor(c.primary));
    board.style.setProperty("--team-accent", acc);
    board.style.setProperty("--team-on-accent", onColor(acc));
  }

  // The 26 draftable slots for the Rosters grid (from feasibility.js).
  const SLOTS = Feasibility.draftSlots();
  const rankOf = (p) => (Number.isFinite(p.rank) ? p.rank : Infinity);
  const RANK_BY_KEY = {};
  PLAYERS.forEach((p) => { RANK_BY_KEY[playerKey(p)] = rankOf(p); });
  const STORAGE_KEY = "cas_draft_v1";

  // ---------------------------------------------------------------- state
  // picks: [{ key, id, name, team, positions, pos, manager, bid, keeper?, keeperYear? }]
  let state = loadState();

  function defaultState() {
    return {
      activeTeam: DRAFT_ORDER[0],
      order: DRAFT_ORDER.slice(),
      picks: [],
      budgets: {}, // manager -> custom total budget (defaults to BUDGET)
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.picks)) return defaultState();
      if (!Array.isArray(parsed.order) || !parsed.order.length)
        parsed.order = DRAFT_ORDER.slice();
      if (!parsed.activeTeam) parsed.activeTeam = parsed.order[0];
      if (!parsed.budgets || typeof parsed.budgets !== "object") parsed.budgets = {};
      return parsed;
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("Couldn't save automatically — use Export to back up.", "error");
    }
    if (sync.role === "commish" && !sync.applyingRemote) pushRemote();
  }

  // ---------------------------------------------------------------- live sync
  // role: "local" (no Firebase), "commish" (drives + writes), "viewer" (reads)
  const sync = { role: "local", ref: null, nomRef: null, refData: null, auth: null, user: null, applyingRemote: false };

  function normalizeState(s) {
    s = s || {};
    return {
      activeTeam: s.activeTeam || DRAFT_ORDER[0],
      order: Array.isArray(s.order) && s.order.length ? s.order : DRAFT_ORDER.slice(),
      picks: Array.isArray(s.picks) ? s.picks : s.picks ? Object.values(s.picks) : [],
      budgets: s.budgets && typeof s.budgets === "object" ? s.budgets : {},
    };
  }

  function initSync() {
    const app = initFirebaseApp();
    if (!app || !firebase.database) { sync.role = "local"; return; }

    try {
      const path = typeof SYNC_PATH !== "undefined" && SYNC_PATH ? SYNC_PATH : "draft/current";
      sync.ref = firebase.database().ref(path);
      // Separate lightweight channel for the on-the-block banner, so live bid
      // updates don't trigger a full re-render for every viewer.
      sync.nomRef = firebase.database().ref(path + "-nominated");
      sync.nomRef.on("value", (snap) => { nominated = snap.val() || null; renderNominated(); });

      sync.role = "viewer";

      // Shared keeper reference data (frozen ESPN salaries) so the whole
      // league sees Year-2 costs without each device fetching ESPN.
      sync.refData = firebase.database().ref(path + "-keeperdata");
      sync.refData.on("value", (snap) => {
        if (sync.role === "commish") return; // commissioner is the source of truth
        const r = snap.val();
        if (!r) return;
        if (r.espn) espnAAV = r.espn;
        renderKeeperEligibility();
      });
      sync.ref.on("value", (snap) => {
        const remote = snap.val();
        if (!remote) {
          if (sync.role === "commish") pushRemote();
          else setWaiting(true);
          return;
        }
        setWaiting(false);
        sync.applyingRemote = true;
        state = normalizeState(remote);
        render();
        if (!$("#roster-modal").hidden) refreshOpenRoster();
        sync.applyingRemote = false;
      });

      firebase.database().ref(".info/connected").on("value", (s) => {
        setConnected(!!s.val());
      });

      setupAuth(); // commissioner sign-in decides who can write
    } catch (e) {
      sync.role = "local";
    }
  }

  // ---- Commissioner authentication (Google sign-in) ------------------------
  function allowedCommish(email) {
    const list = (typeof COMMISH_EMAILS !== "undefined" && Array.isArray(COMMISH_EMAILS)) ? COMMISH_EMAILS : [];
    return !!email && list.some((e) => String(e).toLowerCase() === String(email).toLowerCase());
  }
  function setupAuth() {
    if (typeof firebase === "undefined" || !firebase.auth) {
      applyRoleUI();
      return;
    }
    sync.auth = firebase.auth();
    sync.auth.getRedirectResult().catch(() => {});
    sync.auth.onAuthStateChanged((user) => {
      const was = sync.role;
      sync.user = user || null;
      sync.role = user && allowedCommish(user.email) ? "commish" : "viewer";
      applyRoleUI();
      if (sync.role === "commish" && was !== "commish") onBecameCommish();
    });
  }
  function onBecameCommish() {
    pushKeeperData();
    if (sync.ref) sync.ref.once("value").then((snap) => { if (!snap.val()) pushRemote(); }).catch(() => {});
  }
  function signInCommish() {
    if (!sync.auth) return toast("Sign-in isn't available (Firebase Auth didn't load).", "error");
    const provider = new firebase.auth.GoogleAuthProvider();
    sync.auth.signInWithPopup(provider).catch((e) => {
      const code = e && e.code;
      if (code === "auth/popup-blocked" || code === "auth/cancelled-popup-request" ||
          code === "auth/operation-not-supported-in-this-environment") {
        sync.auth.signInWithRedirect(provider).catch(() => {});
      } else if (code !== "auth/popup-closed-by-user") {
        toast("Sign-in failed: " + (e && e.message ? e.message : code || "unknown"), "error");
      }
    });
  }
  function signOutCommish() {
    if (sync.auth) sync.auth.signOut().catch(() => {});
  }

  function pushRemote() {
    if (sync.role !== "commish" || !sync.ref) return;
    sync.ref.set(state).catch(() => toast("Live sync write failed.", "error"));
  }
  function pushKeeperData() {
    if (sync.role !== "commish" || !sync.refData) return;
    sync.refData.set({ espn: espnAAV || null }).catch(() => {});
  }

  // ---------------------------------------------------------------- compute
  const picksOf = (m) => state.picks.filter((p) => p.manager === m);
  const spent = (m) => picksOf(m).reduce((s, p) => s + p.bid, 0);
  const totalBudget = (m) =>
    Number.isFinite(state.budgets[m]) ? state.budgets[m] : BUDGET;
  const isBudgetCustom = (m) => totalBudget(m) !== BUDGET;
  const remainingBudget = (m) => totalBudget(m) - spent(m);
  const remainingSpots = (m) => ROSTER_SIZE - picksOf(m).length;
  function maxBid(m) {
    const spots = remainingSpots(m);
    if (spots <= 0) return 0;
    return remainingBudget(m) - (spots - 1); // reserve $1 per still-empty spot
  }
  const avgPerSlot = (m) => {
    const s = remainingSpots(m);
    return s > 0 ? Math.floor(remainingBudget(m) / s) : 0;
  };
  const pickFor = (key) => state.picks.find((p) => p.key === key) || null;
  const keepersOf = (m) => picksOf(m).filter((p) => p.keeper);
  const rosterPositions = (m) => picksOf(m).map((p) => positionsOf(p));
  // "Can this manager legally add this player?" — slot feasibility, not caps.
  const canDraft = (m, player) => Feasibility.canFit(rosterPositions(m), positionsOf(player));

  // ---------------------------------------------------------------- render
  function render() {
    renderTeamSelect();
    renderActiveTeamMeta();
    renderBoard();
    renderManagers();
    renderUndrafted();
    renderRosters();
    renderKeepers();
    renderLimits();
    renderLog();
    renderRecap();
    renderNominated();
    renderSummary();
    saveState();
    maybeSoldEffect();
    maybeCelebrate();
  }

  function renderTeamSelect() {
    const sel = $("#team-select");
    sel.innerHTML = "";
    state.order.forEach((abbr, i) => {
      const t = TEAM_BY_ABBR[abbr];
      if (!t) return;
      const done = teamFullyDrafted(abbr);
      const opt = document.createElement("option");
      opt.value = abbr;
      opt.textContent = `${i + 1}. ${t.name}${done ? "  ✓" : ""}`;
      if (abbr === state.activeTeam) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function renderActiveTeamMeta() {
    const t = TEAM_BY_ABBR[state.activeTeam];
    if (!t) return;
    applyTeamTheme(state.activeTeam);
    const logo = $("#active-team-logo");
    logo.src = teamLogoUrl(state.activeTeam);
    logo.alt = t.name;
    $("#active-team-name").textContent = t.name;
    const teamPlayers = PLAYERS.filter((p) => p.team === state.activeTeam);
    const draftedCount = teamPlayers.filter((p) => pickFor(playerKey(p))).length;
    $("#active-team-progress").textContent =
      `${draftedCount}/${teamPlayers.length} drafted`;
  }

  function teamFullyDrafted(abbr) {
    const tp = PLAYERS.filter((p) => p.team === abbr);
    return tp.length > 0 && tp.every((p) => pickFor(playerKey(p)));
  }

  function renderBoard() {
    const board = $("#player-board");
    board.innerHTML = "";
    const filter = $("#player-search").value.trim().toLowerCase();
    const teamPlayers = PLAYERS.filter((p) => p.team === state.activeTeam);

    // Two columns: hitters (C/1B/2B/3B/SS/DH) left, OF + pitchers right.
    const left = document.createElement("div");
    left.className = "board-col";
    const right = document.createElement("div");
    right.className = "board-col";
    const colFor = { C: left, "1B": left, "2B": left, "3B": left, SS: left, DH: left,
                     OF: right, SP: right, RP: right };

    let anyShown = false;
    POSITION_ORDER.forEach((pos) => {
      let group = teamPlayers.filter((p) => primaryPos(p) === pos);
      if (filter) group = group.filter((p) => p.name.toLowerCase().includes(filter));
      if (!group.length) return;

      // available first (best rank first), then drafted
      group.sort((a, b) => {
        const da = pickFor(playerKey(a)) ? 1 : 0;
        const db = pickFor(playerKey(b)) ? 1 : 0;
        return da - db || rankOf(a) - rankOf(b) || a.name.localeCompare(b.name);
      });

      const wrap = document.createElement("div");
      wrap.className = "pos-group";
      const title = document.createElement("div");
      title.className = "pos-group-title";
      title.innerHTML = `<span class="pos-badge pos-${pos}">${pos}</span> ${posLabel(pos)}`;
      wrap.appendChild(title);

      group.forEach((p) => {
        anyShown = true;
        wrap.appendChild(playerRow(p));
      });
      (colFor[pos] || right).appendChild(wrap);
    });

    if (!anyShown) {
      const note = document.createElement("div");
      note.className = filter ? "empty-note" : "all-drafted-note";
      note.textContent = filter
        ? "No players match your filter on this club."
        : "Every listed player on this club has been drafted. Move to the next club ›";
      board.appendChild(note);
      return;
    }

    board.appendChild(left);
    board.appendChild(right);
  }

  function posLabel(pos) {
    return { C: "Catchers", "1B": "First Base", "2B": "Second Base", "3B": "Third Base",
             SS: "Shortstops", DH: "Designated Hitters", OF: "Outfielders",
             SP: "Starting Pitchers", RP: "Relief Pitchers" }[pos] || pos;
  }

  function playerRow(p) {
    const row = document.createElement("div");
    const pick = pickFor(playerKey(p));
    row.className = "player-row" + (pick ? " drafted" : "");

    row.insertAdjacentHTML("beforeend", avatarHTML(p, 40));

    const name = document.createElement("span");
    name.className = "player-name";
    name.innerHTML = escapeHtml(p.name) +
      (positionsOf(p).length > 1
        ? `<span class="pn-pos">${posBadges(positionsOf(p).slice(1), "sm dim")}</span>`
        : "");
    row.appendChild(name);

    if (pick) {
      const tag = document.createElement("span");
      tag.className = "player-tag";
      const kept = pick.keeper
        ? `<span class="kept-badge${pick.keeperYear === 2 ? " y2" : ""}">KEPT Y${pick.keeperYear}</span> `
        : "";
      tag.innerHTML = `${kept}${escapeHtml(pick.manager)} · <span class="price">$${pick.bid}</span>`;
      row.appendChild(tag);
      row.title = pick.keeper ? "Kept player — manage on the Keepers tab" : "Click to undo this pick";
      if (!pick.keeper) row.addEventListener("click", () => undoPick(pick.key));
    } else {
      const btn = document.createElement("button");
      btn.className = "btn btn-small btn-primary";
      btn.textContent = "Draft";
      btn.addEventListener("click", () => openAuction(p));
      row.appendChild(btn);
    }
    return row;
  }

  function renderManagers() {
    const body = $("#managers-body");
    body.innerHTML = "";

    const rows = MANAGERS
      .map((m) => ({ m, budget: remainingBudget(m), max: maxBid(m), spots: remainingSpots(m) }))
      .sort((a, b) => b.budget - a.budget || b.max - a.max);

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.spots <= 0) tr.className = "mgr-full";
      tr.innerHTML =
        `<td class="mgr-name">${escapeHtml(r.m)}</td>` +
        `<td class="mgr-budget">$${r.budget}</td>` +
        `<td class="mgr-max">$${r.max}</td>` +
        `<td>${r.spots}</td>`;
      tr.addEventListener("click", () => openRoster(r.m));
      body.appendChild(tr);
    });
  }

  function renderSummary() {
    const total = state.picks.length;
    const cap = MANAGERS.length * ROSTER_SIZE;
    $("#draft-summary").textContent = `${total}/${cap} players drafted`;
  }

  // ---------------------------------------------------------------- undrafted tab
  function renderUndrafted() {
    const host = $("#undrafted-board");
    if (!host) return;
    const filter = ($("#undrafted-search").value || "").trim().toLowerCase();
    const available = PLAYERS.filter((p) => !pickFor(playerKey(p)));

    host.innerHTML = "";
    POSITION_ORDER.forEach((pos) => {
      let group = available.filter((p) => primaryPos(p) === pos);
      const totalLeft = group.length;
      if (filter) group = group.filter((p) => p.name.toLowerCase().includes(filter));
      group.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));

      const col = document.createElement("div");
      col.className = "undrafted-col";
      col.innerHTML =
        `<div class="pos-group-title"><span class="pos-badge pos-${pos}">${pos}</span> ` +
        `${posLabel(pos)} <span class="pos-left">${totalLeft} left</span></div>`;

      if (!group.length) {
        col.insertAdjacentHTML("beforeend", `<div class="empty-note">None available.</div>`);
      } else {
        group.forEach((p) => {
          const row = document.createElement("div");
          row.className = "undrafted-row";
          row.title = "Draft " + p.name;
          row.insertAdjacentHTML("beforeend", avatarHTML(p, 30));
          row.insertAdjacentHTML(
            "beforeend",
            `<span class="ud-name">${escapeHtml(p.name)}</span>` +
              `<span class="ud-team">${escapeHtml(p.team)}${positionsOf(p).length > 1 ? " · " + positionsOf(p).join("/") : ""}</span>`
          );
          row.addEventListener("click", () => openAuction(p));
          col.appendChild(row);
        });
      }
      host.appendChild(col);
    });
  }

  // ---------------------------------------------------------------- rosters tab
  function renderRosters() {
    const grid = $("#rosters-grid");
    if (!grid) return;

    const order = MANAGERS.map((m) => ({ m, cells: Feasibility.assignSlots(picksOf(m)).cells }));

    let html = "<thead><tr>";
    order.forEach(({ m }) => {
      html +=
        `<th><div class="rg-team">${escapeHtml(m)}</div>` +
        `<div class="rg-stats"><span>Max $${maxBid(m)}</span>` +
        `<span>${remainingSpots(m)} · $${remainingBudget(m)}</span></div></th>`;
    });
    html += "</tr></thead><tbody>";

    SLOTS.forEach((slot, i) => {
      html += "<tr>";
      order.forEach(({ cells }) => {
        const cell = cells[i];
        const cls = slot === "BN" ? "rg-bn" : "rg-start";
        if (cell.player) {
          const p = cell.player;
          html +=
            `<td class="rg-cell ${cls}">` +
            `<span class="rg-filled"><span class="rg-slot-tag">${slot}</span>${avatarHTML(p, 22)}` +
            `<span class="rg-pname">${escapeHtml(p.name)}</span>` +
            `<span class="rg-bid">$${p.bid}</span></span></td>`;
        } else {
          html += `<td class="rg-cell ${cls} empty"><span class="rg-slot-empty">${slot}</span></td>`;
        }
      });
      html += "</tr>";
    });
    html += "</tbody>";
    grid.innerHTML = html;
  }

  // ---------------------------------------------------------------- keepers tab
  function renderKeepers() {
    const host = $("#keepers-grid");
    if (!host) return;
    let html = "";
    MANAGERS.forEach((m) => {
      const ks = keepersOf(m);
      const keptSpend = ks.reduce((s, p) => s + p.bid, 0);
      html += `<div class="keeper-card">`;
      html +=
        `<div class="keeper-card-head"><span class="kc-name">${escapeHtml(m)}</span>` +
        `<span class="kc-sub">${ks.length}/${KEEPER.max} · $${keptSpend} kept</span></div>`;
      ks.forEach((p) => {
        const yr = p.keeperYear === 2
          ? `<span class="kept-badge y2">Y2 · final</span>`
          : `<span class="kept-badge">Y1</span>`;
        html +=
          `<div class="keeper-slot">` +
          `<div class="ks-top">` +
          avatarHTML(p, 28) +
          `<span class="ks-name">${escapeHtml(p.name)}</span>` +
          `<span class="ks-cost">$${p.bid}</span></div>` +
          `<div class="ks-bottom">` +
          `<span class="ks-meta">${positionsOf(p).join("/")} · ${escapeHtml(p.team)}</span>` +
          yr +
          `<button class="link-btn keeper-remove" data-key="${escapeHtml(p.key)}">remove</button>` +
          `</div></div>`;
      });
      if (ks.length < KEEPER.max) {
        html += remainingSpots(m) > 0
          ? `<button class="keeper-add btn btn-small" data-mgr="${escapeHtml(m)}">+ Add keeper</button>`
          : `<div class="keeper-add-disabled">Roster full — no room to keep</div>`;
      }
      html += `</div>`;
    });
    host.innerHTML = html;

    host.querySelectorAll(".keeper-add").forEach((b) =>
      b.addEventListener("click", () => openKeeperModal(b.getAttribute("data-mgr")))
    );
    host.querySelectorAll(".keeper-remove").forEach((b) =>
      b.addEventListener("click", () => removeKeeper(b.getAttribute("data-key")))
    );

    renderPriorStatus();
    renderKeeperEligibility();
  }

  function renderPriorStatus() {
    const el = $("#prior-status");
    if (!el) return;
    if (priorConfigured()) {
      el.className = "prior-status loaded";
      el.textContent = `✓ ${PRIOR_SEASON.season} league data loaded — keeper year & cost auto-fill when you pick a player.`;
      el.hidden = false;
    } else {
      el.className = "prior-status";
      el.textContent = `First league season — no prior draft to import. Enter each keeper's details manually below.`;
      el.hidden = false;
    }
  }

  // Three-column eligibility card from last season's draft/rosters: who can be
  // a Year 1 / Year 2 keeper, and who's used up both years.
  let keeperEligPos = "ALL";
  function priorConfigured() {
    return typeof PRIOR_SEASON !== "undefined" && PRIOR_SEASON && PRIOR_SEASON.map;
  }
  function renderKeeperEligibility() {
    const host = $("#keeper-eligibility");
    if (!host) return;
    if (!priorConfigured()) {
      host.innerHTML =
        `<div class="ke-head"><h3>Keeper Eligibility</h3></div>` +
        `<p class="ke-empty">This is the league's first season, so every keeper is entered manually. ` +
        `From next year on, this card fills in automatically from our own draft results: ` +
        `who's Year-1 eligible (last price + $5), Year-2 eligible (ESPN avg), and who must return to the pool.</p>`;
      return;
    }
    const buckets = { year1: [], year2: [], ineligible: [] };
    Object.values(PRIOR_SEASON.map).forEach((d) => {
      if (d.rostered === false) return; // dropped since the draft → not keepable
      if (keeperEligPos !== "ALL" && d.pos !== keeperEligPos) return;
      const e = { name: d.name, pos: d.pos, amount: d.amount, undrafted: !!d.undrafted, owner: d.owner || "" };
      if (d.keeperLast && d.keeperPrev) buckets.ineligible.push(e);
      else if (d.keeperLast) buckets.year2.push(e);
      else buckets.year1.push(e);
    });
    const posIdx = (p) => { const i = POSITION_ORDER.indexOf(p); return i === -1 ? 99 : i; };
    const year1Cost = (e) => (e.undrafted ? KEEPER.undraftedPrice : e.amount + KEEPER.y1Inflation);
    const year2Cost = (e) => { const av = espnValueFor(e.name); return av != null ? Math.max(1, Math.round(av)) : -1; };
    const byPosCost = (cost) => (a, b) =>
      posIdx(a.pos) - posIdx(b.pos) || cost(b) - cost(a) || a.name.localeCompare(b.name);
    buckets.year1.sort(byPosCost(year1Cost));
    buckets.year2.sort(byPosCost(year2Cost));
    buckets.ineligible.sort((a, b) => posIdx(a.pos) - posIdx(b.pos) || a.name.localeCompare(b.name));

    const posBadge = (pos) => (pos ? `<span class="pos-badge pos-${pos}">${escapeHtml(pos)}</span>` : "");
    const rows = (arr, hint) =>
      arr.length
        ? arr.map((e) =>
            `<div class="ke-row">${posBadge(e.pos)}` +
            `<span class="ke-info"><span class="ke-name">${escapeHtml(e.name)}</span>` +
            (e.owner ? `<span class="ke-owner">${escapeHtml(e.owner)}</span>` : "") +
            `</span><span class="ke-cost">${hint(e)}</span></div>`
          ).join("")
        : `<div class="empty-note">None.</div>`;

    const posFilter = ["ALL"].concat(POSITION_ORDER)
      .map((p) => `<button class="ke-pos-btn${keeperEligPos === p ? " active" : ""}" data-pos="${p}">${p === "ALL" ? "All" : p}</button>`)
      .join("");

    const col = (cls, title, n, sub, body) =>
      `<div class="ke-col ${cls}"><div class="ke-col-head">${title} <span class="ke-count">${n}</span></div>` +
      `<div class="ke-col-sub">${sub}</div>${body}</div>`;

    host.innerHTML =
      `<div class="ke-head"><h3>Keeper Eligibility</h3>` +
      `<span class="ke-sub">From the ${escapeHtml(String(PRIOR_SEASON.season))} season — dropped players excluded; waiver/FA pickups keep as Year 1 ($${KEEPER.undraftedPrice}).</span>` +
      `<div class="ke-pos-filter">${posFilter}</div></div>` +
      `<div class="ke-cols">` +
      col("ke-col-y1", "Year 1 eligible", buckets.year1.length,
        `Not kept last year · cost = draft $ + $${KEEPER.y1Inflation} (or $${KEEPER.undraftedPrice} if undrafted)`,
        rows(buckets.year1, (e) => (e.undrafted ? `undrafted → $${KEEPER.undraftedPrice}` : `$${e.amount} → $${e.amount + KEEPER.y1Inflation}`))) +
      col("ke-col-y2", "Year 2 eligible", buckets.year2.length,
        "Kept once · cost = ESPN avg (final year)",
        rows(buckets.year2, (e) => {
          const av = espnValueFor(e.name);
          return av != null ? `was $${e.amount} → $${Math.max(1, Math.round(av))}` : `was $${e.amount} → ESPN avg`;
        })) +
      col("ke-col-x", "Not eligible", buckets.ineligible.length,
        "Kept two years running · back to the pool",
        rows(buckets.ineligible, () => `kept 2 yrs`)) +
      `</div>`;

    host.querySelectorAll(".ke-pos-btn").forEach((b) =>
      b.addEventListener("click", () => { keeperEligPos = b.dataset.pos; renderKeeperEligibility(); })
    );
  }

  // ----- keeper modal (assign a kept player + compute its cost) -----
  function eligibleKeeperPlayers() {
    return PLAYERS.filter((p) => !pickFor(playerKey(p)));
  }

  function openKeeperModal(m) {
    if (sync.role === "viewer") return;
    const msel = $("#keeper-manager");
    msel.innerHTML = "";
    MANAGERS.forEach((mm) => {
      const opt = document.createElement("option");
      opt.value = mm;
      opt.textContent = mm;
      if (mm === m) opt.selected = true;
      msel.appendChild(opt);
    });

    $("#keeper-search").value = "";
    populateKeeperPlayers("");
    $("#keeper-custom-toggle").checked = false;
    $("#keeper-custom").hidden = true;
    $("#keeper-pool").hidden = false;
    $("#keeper-custom-name").value = "";
    if ($("#keeper-custom-team").options.length) $("#keeper-custom-team").selectedIndex = 0;
    if ($("#keeper-custom-pos").options.length) $("#keeper-custom-pos").selectedIndex = 0;

    const y1 = document.querySelector('input[name="keeper-year"][value="1"]');
    if (y1) y1.checked = true;
    $("#keeper-undrafted").checked = false;
    $("#keeper-prior").value = "";
    $("#keeper-espn").value = "";
    $("#keeper-espn").dataset.auto = "1"; // allow ESPN auto-fill into the empty field
    ensureEspnAAV();                       // warm the live-salary cache while they pick
    updateKeeperYearUI();
    hideKeeperError();
    applyKeeperSuggestion();
    $("#keeper-modal").hidden = false;
    $("#keeper-search").focus();
  }

  function populateKeeperPlayers(filter) {
    const sel = $("#keeper-player");
    if (!sel) return;
    const f = (filter || "").trim().toLowerCase();
    let list = eligibleKeeperPlayers();
    if (f) list = list.filter((p) => p.name.toLowerCase().includes(f));
    list.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));
    const capped = list.slice(0, 300);
    sel.innerHTML = "";
    if (!capped.length) {
      sel.add(new Option("No matches — add manually below", ""));
    } else {
      capped.forEach((p) => sel.add(new Option(`${p.name} — ${positionsOf(p).join("/")} · ${p.team}`, playerKey(p))));
      sel.selectedIndex = 0;
    }
    applyKeeperSuggestion();
  }

  function selectedKeeperYear() {
    const r = document.querySelector('input[name="keeper-year"]:checked');
    return r ? parseInt(r.value, 10) : 1;
  }

  function computeKeeperCost() {
    const yr = selectedKeeperYear();
    if (yr === 1) {
      if ($("#keeper-undrafted").checked) return KEEPER.undraftedPrice;
      const prior = parseFloat($("#keeper-prior").value);
      if (!Number.isFinite(prior)) return null;
      return Math.round(prior) + KEEPER.y1Inflation;
    }
    const avg = parseFloat($("#keeper-espn").value);
    if (!Number.isFinite(avg)) return null;
    return Math.max(1, Math.round(avg)); // ESPN avg, rounded .5↑/.4↓, $1 min bid
  }

  function updateKeeperYearUI() {
    const yr = selectedKeeperYear();
    $("#keeper-cost-y1").hidden = yr !== 1;
    $("#keeper-cost-y2").hidden = yr !== 2;
    $("#keeper-prior-row").hidden = yr !== 1 || $("#keeper-undrafted").checked;
    updateKeeperComputed();
    syncEspnField();
  }

  function updateKeeperComputed() {
    const el = $("#keeper-computed");
    if (!el) return;
    const yr = selectedKeeperYear();
    const undrafted = $("#keeper-undrafted").checked;
    const cost = computeKeeperCost();
    if (cost == null) {
      el.classList.remove("ready");
      el.textContent = yr === 1
        ? "Enter last year's draft cost to see the keeper price."
        : "Enter the ESPN AVG salary to see the keeper price.";
      return;
    }
    el.classList.add("ready");
    const formula = yr === 1
      ? (undrafted ? `(undrafted keep · flat $${KEEPER.undraftedPrice})` : `(last year + $${KEEPER.y1Inflation})`)
      : "(ESPN avg, rounded)";
    el.innerHTML = `Keeper cost: <b>$${cost}</b> <span class="kc-formula">${formula}</span>`;
  }

  function submitKeeper(e) {
    e.preventDefault();
    if (sync.role === "viewer") return;
    const manager = $("#keeper-manager").value;
    if (!manager) return showKeeperError("Pick a team.");

    let player = null;
    if ($("#keeper-custom-toggle").checked) {
      const name = $("#keeper-custom-name").value.trim();
      const team = $("#keeper-custom-team").value;
      const pos = $("#keeper-custom-pos").value;
      if (!name) return showKeeperError("Enter the player's name.");
      if (!team) return showKeeperError("Pick the player's MLB club.");
      if (!pos) return showKeeperError("Pick the player's position.");
      player = { name, team, positions: [pos] };
    } else {
      const key = $("#keeper-player").value;
      if (!key) return showKeeperError("Pick a player, or add one manually.");
      player = PLAYERS.find((p) => playerKey(p) === key);
      if (!player) return showKeeperError("Couldn't find that player.");
    }

    const key = playerKey(player);
    if (pickFor(key)) return showKeeperError(`${player.name} is already on a roster.`);
    const sug = keeperSuggestion(player);
    if (sug && sug.kind === "ineligible") {
      if (!confirm(sug.note + "\n\nAdd them anyway?"))
        return showKeeperError("Already kept twice — should return to the draft pool.");
    }
    if (keepersOf(manager).length >= KEEPER.max) return showKeeperError(`${manager} already has ${KEEPER.max} keepers.`);
    if (remainingSpots(manager) <= 0) return showKeeperError(`${manager}'s roster is full.`);
    if (!canDraft(manager, player))
      return showKeeperError(`${manager} has no roster slot left that fits ${positionsOf(player).join("/")}.`);

    const yr = selectedKeeperYear();
    const cost = computeKeeperCost();
    if (cost == null || cost < 1)
      return showKeeperError(yr === 1 ? "Enter last year's draft cost." : "Enter a valid ESPN AVG salary.");
    const max = maxBid(manager);
    if (cost > max)
      return showKeeperError(
        `That keeper costs $${cost}, but ${manager} can spend at most $${max} (keeping $1 for each remaining spot).`
      );

    const pick = {
      key, id: player.id || null, name: player.name, team: player.team,
      positions: positionsOf(player), pos: primaryPos(player),
      manager, bid: cost, keeper: true, keeperYear: yr,
    };
    if (yr === 1) {
      if ($("#keeper-undrafted").checked) pick.undrafted = true;
      else pick.priorCost = Math.round(parseFloat($("#keeper-prior").value));
    } else {
      pick.espnAvg = parseFloat($("#keeper-espn").value);
    }
    state.picks.push(pick);
    closeKeeperModal();
    render();
    toast(`${player.name} kept by ${manager} for $${cost}.`, "success");
  }

  function closeKeeperModal() {
    $("#keeper-modal").hidden = true;
  }
  function showKeeperError(msg) {
    const el = $("#keeper-error");
    el.textContent = msg;
    el.hidden = false;
  }
  function hideKeeperError() { $("#keeper-error").hidden = true; }

  function removeKeeper(key) {
    if (sync.role === "viewer") return;
    const pick = pickFor(key);
    if (!pick) return;
    if (!confirm(`Remove keeper ${pick.name} (${pick.manager})? Returns them to the draft pool.`)) return;
    state.picks = state.picks.filter((p) => p.key !== key);
    render();
    if (!$("#roster-modal").hidden) refreshOpenRoster();
    toast(`Removed keeper ${pick.name}.`, "success");
  }

  function clearKeepers() {
    if (sync.role === "viewer") return;
    const keepers = state.picks.filter((p) => p.keeper);
    if (!keepers.length) return toast("No keepers to clear.", "error");
    if (!confirm(`Remove all ${keepers.length} keeper(s)? Returns them to the draft pool.`)) return;
    state.picks = state.picks.filter((p) => !p.keeper);
    render();
    toast("All keepers cleared.", "success");
  }

  // ----- ESPN live "AVG SALARY" (Year-2 keeper cost, fantasy baseball) -----
  // espnAAV = { date:"YYYY-MM-DD", frozen:bool, map:{ normName -> dollars } }
  // Live (re-fetched ~once/day) until ESPN_KEEPER_DEADLINE, then frozen.
  let espnAAV = null;
  let espnFetching = null;
  const ESPN_CACHE_KEY = "cas_espn_aav";
  function espnConfigured() {
    return typeof ESPN_SEASON !== "undefined" && !!ESPN_SEASON;
  }
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function pastDeadline() {
    const dl = typeof ESPN_KEEPER_DEADLINE !== "undefined" ? ESPN_KEEPER_DEADLINE : null;
    return dl ? todayStr() >= dl : false;
  }
  function loadEspnCache() {
    try { const raw = localStorage.getItem(ESPN_CACHE_KEY); if (raw) espnAAV = JSON.parse(raw); } catch (e) {}
  }
  async function ensureEspnAAV() {
    if (!espnConfigured()) return null;
    if (!espnAAV) loadEspnCache();
    if (sync.role === "viewer") return espnAAV;               // viewers use the commish's synced values
    if (espnAAV && espnAAV.frozen) return espnAAV;            // locked — never refetch
    if (espnAAV && espnAAV.date === todayStr() && !pastDeadline()) return espnAAV;
    if (espnFetching) return espnFetching;
    espnFetching = (async () => {
      try {
        const filter = JSON.stringify({ players: { sortPercOwned: { sortPriority: 1, sortAsc: false } } });
        const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${ESPN_SEASON}` +
          `/players?scoringPeriodId=0&view=kona_player_info&_=${Date.now()}`;
        const res = await fetch(url, { headers: { "X-Fantasy-Filter": filter } });
        if (!res.ok) throw new Error("ESPN " + res.status);
        const list = await res.json();
        const map = {};
        (list || []).forEach((p) => {
          const aav = (p.ownership || {}).auctionValueAverage;
          if (aav > 0 && p.fullName) map[normName(p.fullName)] = Math.round(aav * 10) / 10;
        });
        if (Object.keys(map).length) {
          espnAAV = { date: todayStr(), frozen: pastDeadline(), season: ESPN_SEASON, map };
          try { localStorage.setItem(ESPN_CACHE_KEY, JSON.stringify(espnAAV)); } catch (e) {}
          pushKeeperData(); // share the (possibly now-frozen) salaries with the league
        }
      } catch (e) { /* keep any prior cache; Year-2 falls back to manual entry */ }
      finally { espnFetching = null; }
      return espnAAV;
    })();
    return espnFetching;
  }
  function espnValueFor(name) {
    return espnAAV && espnAAV.map ? espnAAV.map[normName(name)] : undefined;
  }

  // Given a player, suggest the keeper year + cost from prior-season data.
  let priorByName = null;
  function priorFor(player) {
    if (!priorConfigured() || !player) return null;
    if (player.id && PRIOR_SEASON.map[String(player.id)]) return PRIOR_SEASON.map[String(player.id)];
    if (!priorByName) {
      priorByName = {};
      Object.values(PRIOR_SEASON.map).forEach((d) => { priorByName[normName(d.name)] = d; });
    }
    return priorByName[normName(player.name)] || null;
  }
  function keeperSuggestion(player) {
    if (!priorConfigured() || !player) return null;
    const d = priorFor(player);
    if (!d) {
      return { kind: "undrafted", year: 1,
        note: `Not in the ${PRIOR_SEASON.season} draft — treated as undrafted (flat $${KEEPER.undraftedPrice}).` };
    }
    if (d.keeperLast && d.keeperPrev) {
      return { kind: "ineligible",
        note: `${d.name} was kept in ${PRIOR_SEASON.season} and the season before — already kept twice, so they must return to the draft pool.` };
    }
    if (d.keeperLast) {
      return { kind: "year2", year: 2,
        note: `${d.name} was a Year-1 keeper in ${PRIOR_SEASON.season} ($${d.amount}). This is Year 2 — cost is the ESPN AVG salary.` };
    }
    if (d.undrafted) {
      return { kind: "undrafted", year: 1,
        note: `${d.name} wasn't in the ${PRIOR_SEASON.season} draft (waiver/FA pickup) → flat $${KEEPER.undraftedPrice}.` };
    }
    return { kind: "year1", year: 1, priorCost: d.amount,
      note: `${d.name} was drafted for $${d.amount} in ${PRIOR_SEASON.season} → Year 1 = $${d.amount + KEEPER.y1Inflation}.` };
  }
  function currentKeeperPlayer() {
    if ($("#keeper-custom-toggle").checked) {
      const name = $("#keeper-custom-name").value.trim();
      if (!name) return null;
      const pos = $("#keeper-custom-pos").value;
      return { name, team: $("#keeper-custom-team").value, positions: pos ? [pos] : [] };
    }
    const key = $("#keeper-player").value;
    if (!key) return null;
    return PLAYERS.find((p) => playerKey(p) === key) || null;
  }
  function applyKeeperSuggestion() {
    const noteEl = $("#keeper-suggestion");
    const player = currentKeeperPlayer();
    const s = keeperSuggestion(player);
    if (!s) { if (noteEl) noteEl.hidden = true; syncEspnField(); return; }
    if (s.kind === "ineligible") {
      const y1 = document.querySelector('input[name="keeper-year"][value="1"]');
      if (y1) y1.checked = true;
      $("#keeper-undrafted").checked = false;
      $("#keeper-prior").value = "";
      $("#keeper-espn").value = "";
      updateKeeperYearUI();
      if (noteEl) { noteEl.className = "keeper-suggestion warn"; noteEl.textContent = "⚠ " + s.note; noteEl.hidden = false; }
      return;
    }
    const yrRadio = document.querySelector(`input[name="keeper-year"][value="${s.year}"]`);
    if (yrRadio) yrRadio.checked = true;
    if (s.kind === "undrafted") {
      $("#keeper-undrafted").checked = true;
    } else if (s.kind === "year1") {
      $("#keeper-undrafted").checked = false;
      $("#keeper-prior").value = s.priorCost;
    } else if (s.kind === "year2") {
      $("#keeper-undrafted").checked = false;
    }
    updateKeeperYearUI();
    if (noteEl) { noteEl.className = "keeper-suggestion"; noteEl.textContent = "💡 " + s.note; noteEl.hidden = false; }
  }

  // Auto-fill the Year-2 "ESPN AVG SALARY" field and show live/locked status.
  function syncEspnField() {
    const note = $("#keeper-espn-note");
    const inp = $("#keeper-espn");
    if (!inp) return;
    if (selectedKeeperYear() !== 2) { if (note) note.hidden = true; return; }
    const player = currentKeeperPlayer();
    const apply = () => {
      const av = player ? espnValueFor(player.name) : undefined;
      if (av != null && (!inp.value || inp.dataset.auto === "1")) {
        inp.value = av; inp.dataset.auto = "1"; updateKeeperComputed();
      }
      if (!note) return;
      if (!player) { note.hidden = true; return; }
      note.hidden = false;
      const frozen = !!(espnAAV && espnAAV.frozen);
      note.className = "keeper-espn-note" + (frozen ? " frozen" : " live");
      if (av != null) {
        note.textContent = frozen
          ? `🔒 ESPN avg $${av} — locked as of ${ESPN_KEEPER_DEADLINE}.`
          : `🟢 ESPN avg $${av} — live (updated ${espnAAV ? espnAAV.date : "today"}).`;
      } else {
        note.textContent = espnAAV ? "No ESPN avg found for this player — enter it manually." : "Fetching ESPN avg…";
      }
    };
    apply();
    ensureEspnAAV().then((d) => { if (d) apply(); });
  }

  // ---------------------------------------------------------------- roster needs tab
  function renderLimits() {
    const grid = $("#limits-grid");
    if (!grid) return;
    const NEED_POS = ["C", "1B", "2B", "3B", "SS", "DH", "OF", "SP", "RP"];
    let html = "<thead><tr><th class='ta-left'>Team</th>";
    NEED_POS.forEach((pos) => (html += `<th>${pos}</th>`));
    html += "<th>Spots</th><th>Budget</th></tr></thead><tbody>";

    MANAGERS.forEach((m) => {
      const open = Feasibility.openPositions(rosterPositions(m));
      html += `<tr><td class="ta-left mgr-name">${escapeHtml(m)}</td>`;
      NEED_POS.forEach((pos) => {
        html += `<td class="limit-cell ${open[pos] ? "limit-open" : "limit-full"}">${open[pos] ? "✓" : "✗"}</td>`;
      });
      const spots = remainingSpots(m);
      html += `<td class="limit-cell${spots <= 0 ? " limit-full" : ""}">${spots}</td>`;
      html += `<td class="limit-cell">$${remainingBudget(m)}</td></tr>`;
    });
    html += "</tbody>";
    grid.innerHTML = html;
  }

  // ---------------------------------------------------------------- tabs
  function setTab(name) {
    ["board", "undrafted", "rosters", "keepers", "limits", "log", "recap"].forEach((t) => {
      const view = $("#view-" + t);
      if (view) view.hidden = t !== name;
    });
    document.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === name)
    );
    // Lazily pull ESPN live salaries the first time the Keepers tab is opened.
    if (name === "keepers") {
      ensureEspnAAV().then((d) => { if (d) renderKeeperEligibility(); });
    }
  }

  // ---------------------------------------------------------------- on-the-block banner
  let nominated = null;
  function setNomination(obj) {
    nominated = obj;
    renderNominated();
    if (sync.role === "commish" && sync.nomRef) sync.nomRef.set(obj).catch(() => {});
  }
  // Spoken "{player} is on the block" announcement (browser text-to-speech).
  let lastSpokenNom = null;
  function getVoicePref() { try { return localStorage.getItem("cas_voice"); } catch (e) { return null; } }
  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const pref = getVoicePref();
    if (pref && pref !== "__off__") {
      const found = voices.find((v) => v.name === pref);
      if (found) return found;
    }
    return (
      voices.find((v) => /en[-_]US/i.test(v.lang) && /(daniel|alex|fred|aaron|male|google us)/i.test(v.name)) ||
      voices.find((v) => /en[-_]US/i.test(v.lang)) ||
      voices.find((v) => /^en/i.test(v.lang)) || null
    );
  }
  // ElevenLabs AI voice (optional) -------------------------------------------
  const elevenCache = new Map();
  function elevenConfigured() {
    return typeof ELEVENLABS_API_KEY !== "undefined" && !!ELEVENLABS_API_KEY;
  }
  function playAudioUrl(url) {
    try { const a = new Audio(url); a.volume = 1; a.play().catch(() => {}); } catch (e) {}
  }
  async function speakEleven(text) {
    if (elevenCache.has(text)) { playAudioUrl(elevenCache.get(text)); return; }
    const voiceId = typeof ELEVENLABS_VOICE_ID !== "undefined" ? ELEVENLABS_VOICE_ID : "JBFqnCBsd6RMkjVDRZzb";
    const modelId = typeof ELEVENLABS_MODEL_ID !== "undefined" ? ELEVENLABS_MODEL_ID : "eleven_multilingual_v2";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: modelId }),
    });
    if (!res.ok) throw new Error("ElevenLabs " + res.status);
    const url = URL.createObjectURL(await res.blob());
    elevenCache.set(text, url);
    playAudioUrl(url);
  }
  function effectiveVoicePref() {
    const pref = getVoicePref();
    if (elevenConfigured()) return pref === "__eleven__" ? "__eleven__" : "__off__";
    return pref != null ? pref : "";
  }
  function announcedRecently(text) {
    try {
      const raw = localStorage.getItem("cas_last_announce");
      if (raw) {
        const r = JSON.parse(raw);
        if (r && r.text === text && Date.now() - r.ts < 4000) return true;
      }
      localStorage.setItem("cas_last_announce", JSON.stringify({ text: text, ts: Date.now() }));
    } catch (e) {}
    return false;
  }
  function speak(text) {
    const pref = effectiveVoicePref();
    if (pref === "__off__") return;
    if (announcedRecently(text)) return;
    if (pref === "__eleven__" && elevenConfigured()) {
      speakEleven(text).catch(() => speakBrowser(text));
      return;
    }
    speakBrowser(text);
  }
  function speakBrowser(text) {
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95; u.pitch = 0.9; u.volume = 1; // a little deeper/slower = more "announcer"
      const v = pickVoice(); if (v) u.voice = v;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  function speakOnTheBlock() {
    if (!nominated) { lastSpokenNom = null; return; }
    if (nominated.name === lastSpokenNom) return;
    lastSpokenNom = nominated.name;
    speak(nominated.name + " is on the block");
  }
  function populateVoices() {
    const sel = $("#voice-select");
    if (!sel) return;
    sel.innerHTML = "";
    if (elevenConfigured()) {
      sel.add(new Option("⚾ AI Announcer", "__eleven__"));
      sel.add(new Option("🔇 Voice off", "__off__"));
    } else {
      const voices = (("speechSynthesis" in window ? window.speechSynthesis.getVoices() : []) || [])
        .slice()
        .sort((a, b) => /^en/i.test(b.lang) - /^en/i.test(a.lang) || a.name.localeCompare(b.name));
      sel.add(new Option("🔊 Auto (browser voice)", ""));
      sel.add(new Option("🔇 Voice off", "__off__"));
      voices.forEach((v) => sel.add(new Option(`${v.name} (${v.lang})`, v.name)));
    }
    sel.value = effectiveVoicePref();
  }

  function renderNominated() {
    const el = $("#block-banner");
    if (!el) return;
    speakOnTheBlock();
    if (!nominated) { el.hidden = true; el.innerHTML = ""; return; }
    const t = TEAM_BY_ABBR[nominated.team];
    el.hidden = false;
    el.innerHTML =
      `<span class="bb-label">On the block</span>` +
      avatarHTML(nominated, 34) +
      `<span class="bb-name">${escapeHtml(nominated.name)}</span>` +
      `<span class="bb-meta">${(nominated.positions || []).join("/")}${t ? " · " + escapeHtml(t.name) : ""}</span>` +
      (nominated.bid ? `<span class="bb-bid">$${nominated.bid}</span>` : "");
  }

  // ---------------------------------------------------------------- draft log tab
  function renderLog() {
    const host = $("#log-board");
    if (!host) return;
    const draftPicks = state.picks.filter((p) => !p.keeper);
    if (!draftPicks.length) {
      host.innerHTML = `<div class="empty-note">No picks yet — the log fills in as players are drafted.</div>`;
      return;
    }
    host.innerHTML = draftPicks
      .map((p, i) => ({ p, num: i + 1 }))
      .reverse()
      .map(({ p, num }) => {
        return (
          `<div class="log-row"><span class="log-num">#${num}</span>` +
          avatarHTML(p, 30) +
          `<span class="log-player">${escapeHtml(p.name)}` +
          `<span class="log-meta">${positionsOf(p).join("/")} · ${escapeHtml(p.team)}</span></span>` +
          `<span class="log-arrow">→</span>` +
          `<span class="log-mgr">${escapeHtml(p.manager)}</span>` +
          `<span class="log-bid">$${p.bid}</span></div>`
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------- recap tab
  function renderRecap() {
    const host = $("#recap-board");
    if (!host) return;
    const picks = state.picks;
    if (!picks.length) {
      host.innerHTML = `<div class="empty-note">No picks yet — the recap fills in as the draft happens.</div>`;
      return;
    }
    const pickLine = (p, val) =>
      `<div class="recap-row">` +
      avatarHTML(p, 26) +
      `<span class="rc-name">${escapeHtml(p.name)}<span class="rc-sub">${positionsOf(p).join("/")} · ${escapeHtml(p.team)} → ${escapeHtml(p.manager)}</span></span>` +
      `<span class="rc-val">${val}</span></div>`;

    const draftPicks = picks.filter((p) => !p.keeper);
    const bySpend = draftPicks.slice().sort((a, b) => b.bid - a.bid).slice(0, 8);
    const valued = draftPicks
      .filter((p) => Number.isFinite(RANK_BY_KEY[p.key]))
      .map((p) => ({ p, score: (PLAYERS.length + 1 - RANK_BY_KEY[p.key]) / Math.max(p.bid, 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const posSpend = {};
    POSITION_ORDER.forEach((pos) => (posSpend[pos] = { sum: 0, n: 0 }));
    draftPicks.forEach((p) => {
      const pos = primaryPos(p);
      if (posSpend[pos]) { posSpend[pos].sum += p.bid; posSpend[pos].n++; }
    });
    const mgrTotals = MANAGERS.map((m) => ({ m, spent: spent(m), n: picksOf(m).length }))
      .sort((a, b) => b.spent - a.spent);
    // Biggest MLB-club stacks: 4+ players from one club on a fantasy roster.
    const stacks = MANAGERS.map((m) => {
      const byClub = {};
      picksOf(m).forEach((p) => { byClub[p.team] = (byClub[p.team] || 0) + 1; });
      let best = { club: null, n: 0 };
      Object.keys(byClub).forEach((c) => { if (byClub[c] > best.n) best = { club: c, n: byClub[c] }; });
      return { m, club: best.club, n: best.n };
    }).filter((s) => s.n >= 4).sort((a, b) => b.n - a.n).slice(0, 6);

    let html = '<div class="recap-grid">';
    html += `<div class="recap-card"><h3>💰 Biggest Spends</h3>${bySpend.map((p) => pickLine(p, "$" + p.bid)).join("")}</div>`;
    html += `<div class="recap-card"><h3>🪙 Best Values</h3>` +
      (valued.length ? valued.map(({ p }) => pickLine(p, "$" + p.bid)).join("") : `<div class="empty-note">—</div>`) + `</div>`;
    html += `<div class="recap-card"><h3>📊 Spend by Position</h3>` +
      POSITION_ORDER.map((pos) => {
        const d = posSpend[pos];
        return `<div class="recap-row"><span class="pos-badge pos-${pos}">${pos}</span>` +
          `<span class="rc-name">${d.n} drafted</span><span class="rc-val">$${d.sum}</span></div>`;
      }).join("") + `</div>`;
    html += `<div class="recap-card"><h3>🧾 Spent by Team</h3>` +
      mgrTotals.map((r) => `<div class="recap-row"><span class="rc-name">${escapeHtml(r.m)}<span class="rc-sub">${r.n} players</span></span><span class="rc-val">$${r.spent}</span></div>`).join("") + `</div>`;
    html += `<div class="recap-card"><h3>🏟️ Biggest Club Stacks</h3>` +
      (stacks.length ? stacks.map((s) => `<div class="recap-row"><span class="rc-name">${escapeHtml(s.m)}</span><span class="rc-val">${s.n} ${escapeHtml(s.club)}</span></div>`).join("") : `<div class="empty-note">None yet (4+ players from one club)</div>`) + `</div>`;
    html += "</div>";
    host.innerHTML = html;
  }

  // ---------------------------------------------------------------- sold effect (sound + flash)
  let lastPickCount = null;
  let audioCtx = null;
  function maybeSoldEffect() {
    const n = state.picks.length;
    if (lastPickCount !== null && n === lastPickCount + 1) {
      const newest = state.picks[n - 1];
      if (newest && !newest.keeper) soldEffect(newest);
    }
    lastPickCount = n;
  }
  function soldEffect(pick) {
    if (!pick) return;
    toast(`${pick.name} → ${pick.manager} for $${pick.bid}`, "success");
    const f = $("#sold-flash");
    if (f) {
      f.hidden = false;
      f.classList.remove("flash");
      void f.offsetWidth;
      f.classList.add("flash");
      setTimeout(() => { f.hidden = true; }, 750);
    }
    playDing();
  }
  function playDing() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      const now = audioCtx.currentTime;
      const note = (freq, start, dur) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + start);
        g.gain.exponentialRampToValueAtTime(0.22, now + start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(now + start); o.stop(now + start + dur + 0.02);
      };
      note(880, 0, 0.32);
      note(1320, 0.09, 0.34);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- draft-complete celebration
  let completeBaseline = null;
  let celebrated = false;
  function maybeCelebrate() {
    const done = MANAGERS.length > 0 && state.picks.length >= MANAGERS.length * ROSTER_SIZE;
    if (completeBaseline === null) { completeBaseline = done; celebrated = done; return; }
    if (done && !celebrated) { celebrated = true; triggerCelebration(); }
    if (!done) celebrated = false;
  }
  function triggerCelebration() {
    const modal = $("#celebrate");
    if (!modal) return;
    modal.hidden = false;
    spawnConfetti();
    playFanfare();
  }
  function spawnConfetti() {
    const layer = $("#celebrate-confetti");
    if (!layer) return;
    layer.innerHTML = "";
    const colors = ["#e5484d", "#d9a441", "#2ea043", "#61afef", "#c678dd", "#f2e8d5", "#ffffff"];
    for (let i = 0; i < 110; i++) {
      const d = document.createElement("div");
      d.className = "confetti-piece";
      d.style.left = Math.random() * 100 + "%";
      d.style.background = colors[i % colors.length];
      d.style.animationDelay = Math.random() * 1.2 + "s";
      d.style.animationDuration = 2.4 + Math.random() * 1.8 + "s";
      layer.appendChild(d);
    }
  }
  function playFanfare() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      const now = audioCtx.currentTime;
      const note = (freq, start, dur) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "triangle"; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + start);
        g.gain.exponentialRampToValueAtTime(0.25, now + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(now + start); o.stop(now + start + dur + 0.03);
      };
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.13, 0.5));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- printable / shareable results
  function printResults() {
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups to open the printable results.", "error"); return; }
    w.document.open();
    w.document.write(buildResultsHTML());
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
  }
  function buildResultsHTML() {
    const esc = escapeHtml;
    let dateStr = "";
    try { dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); } catch (e) {}

    let body = "";
    MANAGERS.forEach((m) => {
      const { cells } = Feasibility.assignSlots(picksOf(m));
      body += `<div class="team"><h3>${esc(m)} <span class="tot">$${spent(m)} spent · ${picksOf(m).length}/${ROSTER_SIZE} players</span></h3>`;
      body += `<table><thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th>Club</th><th class="r">$</th></tr></thead><tbody>`;
      cells.forEach((c) => {
        const p = c.player;
        body += `<tr><td class="slot">${c.slot}</td>` +
          (p ? `<td>${esc(p.name)}</td><td>${positionsOf(p).join("/")}</td><td>${esc(p.team)}</td><td class="r">$${p.bid}</td>`
             : `<td class="empty" colspan="4">—</td>`) + `</tr>`;
      });
      body += `</tbody></table></div>`;
    });

    let log = `<h2 class="div">Draft Log</h2><table class="logtbl"><thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Club</th><th>Team</th><th class="r">$</th></tr></thead><tbody>`;
    state.picks.forEach((p, i) => {
      log += `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${positionsOf(p).join("/")}</td><td>${esc(p.team)}</td><td>${esc(p.manager)}</td><td class="r">$${p.bid}</td></tr>`;
    });
    log += `</tbody></table>`;

    const styles =
      "*{box-sizing:border-box}" +
      "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;margin:24px}" +
      "h1{margin:0 0 2px;font-size:24px}.date{color:#666;margin-bottom:18px}" +
      "h2.div{font-size:15px;text-transform:uppercase;letter-spacing:.5px;color:#444;border-bottom:2px solid #999;padding-bottom:4px;margin:22px 0 10px}" +
      ".team{margin:0 0 14px;page-break-inside:avoid}.team h3{font-size:15px;margin:0 0 5px}" +
      ".team .tot{font-weight:400;color:#666;font-size:12px}" +
      "table{border-collapse:collapse;width:100%;font-size:12px}" +
      "th,td{border:1px solid #ccc;padding:4px 7px;text-align:left}th{background:#f0f0f0}" +
      "td.r,th.r{text-align:right}td.slot{color:#888;font-style:italic;width:48px}td.empty{color:#bbb;text-align:center}" +
      ".logtbl{font-size:11px}@media print{body{margin:12mm}}";

    return (
      "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Carrollton All-Stars — Draft Results</title>" +
      "<style>" + styles + "</style></head><body>" +
      "<h1>Carrollton All-Stars — Draft Results</h1><div class='date'>" + dateStr + "</div>" +
      body + log + "</body></html>"
    );
  }

  // ---------------------------------------------------------------- auction
  let pendingPlayer = null;

  function openAuction(p) {
    if (sync.role === "viewer") return;
    pendingPlayer = p;
    const t = TEAM_BY_ABBR[p.team];
    $("#auction-player").innerHTML =
      avatarHTML(p, 56) +
      `<div class="ap-text">` +
      `<div class="ap-name">${escapeHtml(p.name)}</div>` +
      `<div class="ap-meta">${positionsOf(p).join("/")}${t ? " · " + escapeHtml(t.name) : ""}</div>` +
      `</div>`;

    const sel = $("#auction-manager");
    sel.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a team…";
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.appendChild(placeholder);
    MANAGERS.forEach((m) => {
      const spots = remainingSpots(m);
      const opt = document.createElement("option");
      opt.value = m;
      if (spots <= 0) {
        opt.textContent = `${m}  — roster full`;
        opt.disabled = true;
      } else if (!canDraft(m, p)) {
        opt.textContent = `${m}  — no slot fits ${positionsOf(p).join("/")}`;
        opt.disabled = true;
      } else {
        opt.textContent = `${m}  (max $${maxBid(m)})`;
      }
      sel.appendChild(opt);
    });

    $("#auction-bid").value = 1;
    setNomination({ name: p.name, team: p.team, positions: positionsOf(p), id: p.id || null, mlbId: p.id || null, bid: 1 });
    hideAuctionError();
    $("#auction-modal").hidden = false;
    $("#auction-manager").focus();
  }

  function closeAuction() {
    $("#auction-modal").hidden = true;
    pendingPlayer = null;
    setNomination(null); // clear the on-the-block banner for everyone
  }

  function submitAuction(e) {
    e.preventDefault();
    if (!pendingPlayer) return;
    const manager = $("#auction-manager").value;
    const bid = parseInt($("#auction-bid").value, 10);

    if (!manager) return showAuctionError("Pick a team.");
    if (!Number.isInteger(bid) || bid < 1) return showAuctionError("Bid must be at least $1.");
    if (remainingSpots(manager) <= 0) return showAuctionError(`${manager}'s roster is full.`);
    if (!canDraft(manager, pendingPlayer))
      return showAuctionError(
        `${manager} has no roster slot left that fits ${positionsOf(pendingPlayer).join("/")}.`
      );
    const max = maxBid(manager);
    if (bid > max)
      return showAuctionError(
        `${manager} can bid at most $${max} (must keep $1 for each remaining spot).`
      );

    state.picks.push({
      key: playerKey(pendingPlayer),
      id: pendingPlayer.id || null,
      name: pendingPlayer.name,
      team: pendingPlayer.team,
      positions: positionsOf(pendingPlayer),
      pos: primaryPos(pendingPlayer),
      manager,
      bid,
    });
    closeAuction();              // hides modal + clears the on-the-block banner
    autoAdvanceIfTeamDone();     // jump to the next club if this one is finished
    render();                    // sold sound/flash/toast fire via maybeSoldEffect
  }

  function showAuctionError(msg) {
    const el = $("#auction-error");
    el.textContent = msg;
    el.hidden = false;
  }
  function hideAuctionError() { $("#auction-error").hidden = true; }

  // ---------------------------------------------------------------- undo
  function undoPick(key) {
    if (sync.role === "viewer") return;
    const pick = pickFor(key);
    if (!pick) return;
    if (!confirm(`Undo ${pick.name} (${pick.manager}, $${pick.bid})?`)) return;
    state.picks = state.picks.filter((p) => p.key !== key);
    render();
    if (!$("#roster-modal").hidden) refreshOpenRoster();
    toast(`Undid ${pick.name}`, "success");
  }

  function undoLast() {
    const draftPicks = state.picks.filter((p) => !p.keeper);
    if (!draftPicks.length) return toast("No draft picks to undo.", "error");
    undoPick(draftPicks[draftPicks.length - 1].key);
  }

  // ---------------------------------------------------------------- roster modal
  let openRosterManager = null;

  function openRoster(m) {
    openRosterManager = m;
    $("#roster-title").textContent = m;
    refreshOpenRoster();
    $("#roster-modal").hidden = false;
  }

  function refreshOpenRoster() {
    const m = openRosterManager;
    if (!m) return;

    const open = Feasibility.openPositions(rosterPositions(m));
    const posSummary = ["C", "1B", "2B", "3B", "SS", "DH", "OF", "SP", "RP"].map((pos) =>
      `<span class="pos-count${open[pos] ? "" : " pos-maxed"}">${pos} ${open[pos] ? "open" : "full"}</span>`
    ).join("");

    $("#roster-summary").innerHTML =
      `<div class="roster-budget-line">` +
      `<label>Total budget $<input type="number" id="roster-budget-input" min="0" step="1" value="${totalBudget(m)}"></label>` +
      `<button type="button" id="roster-budget-save" class="btn btn-small">Save</button>` +
      (isBudgetCustom(m)
        ? `<button type="button" id="roster-budget-reset" class="btn btn-small btn-ghost">Reset to $${BUDGET}</button>`
        : "") +
      `</div>` +
      `<div class="roster-stats">Spent <b>$${spent(m)}</b> · Remaining <b>$${remainingBudget(m)}</b> · ` +
      `Max bid <b>$${maxBid(m)}</b> · Avg/slot <b>$${avgPerSlot(m)}</b> · Spots left <b>${remainingSpots(m)}</b></div>` +
      `<div class="roster-pos-counts">${posSummary}</div>`;

    $("#roster-budget-save").addEventListener("click", () => {
      if (sync.role === "viewer") return;
      const v = parseInt($("#roster-budget-input").value, 10);
      if (!Number.isInteger(v) || v < 0) return toast("Budget must be 0 or more.", "error");
      if (v < spent(m))
        return toast(`${m} has already spent $${spent(m)}; budget can't be lower.`, "error");
      state.budgets[m] = v;
      render();
      refreshOpenRoster();
      toast(`${m} budget set to $${v}.`, "success");
    });
    const resetBtn = $("#roster-budget-reset");
    if (resetBtn)
      resetBtn.addEventListener("click", () => {
        delete state.budgets[m];
        render();
        refreshOpenRoster();
        toast(`${m} budget reset to $${BUDGET}.`, "success");
      });

    const body = $("#roster-body");
    body.innerHTML = "";
    Feasibility.assignSlots(picksOf(m)).cells.forEach((c) => {
      const p = c.player;
      const tr = document.createElement("tr");
      if (p) {
        tr.innerHTML =
          `<td class="slot-label">${c.slot}</td>` +
          `<td class="ta-left"><span class="roster-name">${avatarHTML(p, 26)}${escapeHtml(p.name)}</span></td>` +
          `<td>${positionsOf(p).join("/")}</td>` +
          `<td>${escapeHtml(p.team)}</td>` +
          `<td class="price">$${p.bid}</td>` +
          `<td><button class="link-btn" data-key="${escapeHtml(p.key)}">remove</button></td>`;
      } else {
        tr.className = "roster-slot-empty";
        tr.innerHTML =
          `<td class="slot-label">${c.slot}</td>` +
          `<td class="ta-left roster-empty-cell">—</td>` +
          `<td></td><td></td><td></td><td></td>`;
      }
      body.appendChild(tr);
    });
    body.querySelectorAll(".link-btn").forEach((btn) => {
      btn.addEventListener("click", () => undoPick(btn.getAttribute("data-key")));
    });
  }

  function closeRoster() {
    $("#roster-modal").hidden = true;
    openRosterManager = null;
  }

  // ---------------------------------------------------------------- club nav (the hat)
  function setActiveTeam(abbr) {
    if (sync.role === "viewer") return; // viewers follow the commissioner
    state.activeTeam = abbr;
    $("#player-search").value = "";
    render();
  }

  function stepTeam(delta) {
    const idx = state.order.indexOf(state.activeTeam);
    const next = (idx + delta + state.order.length) % state.order.length;
    setActiveTeam(state.order[next]);
  }

  // After a pick, if the active club has no pool players left, jump to the
  // next club in the draw order that still has someone available.
  function autoAdvanceIfTeamDone() {
    if (!teamFullyDrafted(state.activeTeam)) return;
    const idx = state.order.indexOf(state.activeTeam);
    for (let k = 1; k <= state.order.length; k++) {
      const cand = state.order[(idx + k) % state.order.length];
      if (!teamFullyDrafted(cand)) {
        state.activeTeam = cand;
        $("#player-search").value = "";
        return;
      }
    }
  }

  function shuffleOrder() {
    if (sync.role === "viewer") return;
    if (!confirm("Reshuffle the draw order? (Picks already made are kept.)")) return;
    const a = state.order.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    state.order = a;
    state.activeTeam = a[0];
    render();
    toast("Draw order reshuffled.", "success");
  }

  // ---------------------------------------------------------------- export / import / reset
  function exportDraft() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "carrollton-all-stars-draft.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Draft exported.", "success");
  }

  function importDraft(file) {
    if (sync.role === "viewer") return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.picks)) throw new Error("bad file");
        state = {
          activeTeam: parsed.activeTeam || DRAFT_ORDER[0],
          order: Array.isArray(parsed.order) && parsed.order.length ? parsed.order : DRAFT_ORDER.slice(),
          picks: parsed.picks,
          budgets: parsed.budgets && typeof parsed.budgets === "object" ? parsed.budgets : {},
        };
        render();
        toast("Draft imported.", "success");
      } catch (e) {
        toast("That file couldn't be read as a draft backup.", "error");
      }
    };
    reader.readAsText(file);
  }

  function resetDraft() {
    if (sync.role === "viewer") return;
    const keepers = state.picks.filter((p) => p.keeper);
    const draftCount = state.picks.length - keepers.length;
    const msg = keepers.length
      ? `Reset the draft? Clears ${draftCount} draft pick(s) but KEEPS the ${keepers.length} keeper(s). (Export first to keep a copy.)`
      : "Reset the ENTIRE draft? This clears every pick. (Export first to keep a copy.)";
    if (!confirm(msg)) return;
    state = defaultState();
    state.picks = keepers; // keepers are locked in before the draft, so they survive a reset
    render();
    toast(keepers.length ? "Draft reset (keepers kept)." : "Draft reset.", "success");
  }

  // ---------------------------------------------------------------- publish to season app
  async function publishToLeague() {
    if (sync.role !== "commish") return;
    const app = initFirebaseApp();
    if (!app || !firebase.firestore) return toast("Firestore isn't available — check shared/firebase-init.js.", "error");
    const total = state.picks.length;
    const cap = MANAGERS.length * ROSTER_SIZE;
    const note = total < cap ? ` (draft is ${total}/${cap} — you can re-publish later)` : "";
    if (!confirm(`Publish the draft to the season app?${note}\n\nThis overwrites every team's ${LEAGUE.season} roster, sets auction prices, and resets FAAB to $${FAAB.budget}.`)) return;

    const btn = $("#btn-publish");
    if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
    try {
      const db = firebase.firestore();
      const base = db.collection("leagues").doc(LEAGUE.id);
      const batch = db.batch();
      const now = firebase.firestore.FieldValue.serverTimestamp();

      batch.set(base.collection("drafts").doc(String(LEAGUE.season)), {
        season: LEAGUE.season, publishedAt: now, picks: state.picks,
      });

      const byMgr = {};
      state.picks.forEach((p) => { (byMgr[p.manager] = byMgr[p.manager] || []).push(p); });
      LEAGUE_TEAMS.forEach((t) => {
        const players = {};
        (byMgr[t.name] || []).forEach((p) => {
          players[p.key] = {
            mlbId: p.id || null, name: p.name, mlbTeam: p.team,
            positions: positionsOf(p), via: p.keeper ? "keeper" : "draft", price: p.bid,
          };
        });
        batch.set(base.collection("rosters").doc(t.id), { players, updatedAt: now });
        batch.set(base.collection("teams").doc(t.id), {
          name: t.name, owner: t.owner, ownerEmails: t.emails,
          faabRemaining: FAAB.budget,
          record: { w: 0, l: 0, t: 0, pf: 0, pa: 0 },
        }, { merge: true });
      });

      await batch.commit();
      toast(`Published ${total} picks to the season app. Play ball!`, "success");
    } catch (e) {
      toast("Publish failed: " + (e && e.message ? e.message : "unknown error"), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "📤 Publish to League"; }
    }
  }

  // ---------------------------------------------------------------- role / sync UI
  function applyRoleUI() {
    document.body.classList.toggle("viewer-mode", sync.role === "viewer");
    updateAuthButton();
    const pub = $("#btn-publish");
    if (pub) pub.hidden = !(sync.role === "commish" && typeof firebase !== "undefined" && firebase.firestore);
    const badge = $("#role-badge");
    if (!badge) return;
    if (sync.role === "commish") {
      badge.textContent = "✎ Commissioner · live";
      badge.className = "role-badge role-commish";
      badge.hidden = false;
    } else if (sync.role === "viewer") {
      badge.textContent = "👁 Watching live";
      badge.className = "role-badge role-viewer";
      badge.hidden = false;
    } else {
      badge.hidden = true; // local-only mode: no badge
    }
  }
  function updateAuthButton() {
    const b = $("#btn-auth");
    if (!b) return;
    if (sync.role === "local") { b.hidden = true; return; }
    b.hidden = false;
    if (sync.role === "commish") {
      b.textContent = "Sign out";
      b.className = "btn btn-ghost";
      b.title = sync.user ? "Signed in as " + sync.user.email : "Sign out";
    } else if (sync.user) {
      b.textContent = "Sign out";
      b.className = "btn btn-ghost";
      b.title = (sync.user.email || "This account") + " isn't a commissioner — sign out to switch accounts.";
    } else {
      b.textContent = "✎ Commissioner sign-in";
      b.className = "btn";
      b.title = "Sign in with Google to run the draft";
    }
  }
  function setConnected(connected) {
    const badge = $("#role-badge");
    if (!badge || sync.role === "local") return;
    badge.classList.toggle("disconnected", !connected);
    badge.title = connected ? "Connected to live sync" : "Reconnecting…";
  }
  function setWaiting(waiting) {
    const b = $("#waiting-banner");
    if (b) b.hidden = !(waiting && sync.role === "viewer");
  }

  // ---------------------------------------------------------------- TV mode
  function toggleTvMode(force) {
    const on = typeof force === "boolean" ? force : !document.body.classList.contains("tv-mode");
    document.body.classList.toggle("tv-mode", on);
    const btn = $("#btn-tv");
    if (btn) btn.textContent = on ? "📺 Exit TV Mode" : "📺 TV Mode";
    try { localStorage.setItem("cas_tv", on ? "1" : "0"); } catch (e) {}
    try {
      if (on) {
        if (document.documentElement.requestFullscreen && !document.fullscreenElement)
          document.documentElement.requestFullscreen().catch(() => {});
      } else if (document.exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    const actions = document.querySelector(".topbar-actions");
    wireThemeButton($("#btn-theme"));

    // "Undo last" button next to the export/import controls.
    const undoBtn = document.createElement("button");
    undoBtn.id = "btn-undo";
    undoBtn.className = "btn btn-ghost";
    undoBtn.textContent = "↶ Undo last";
    undoBtn.title = "Undo the most recent pick";
    undoBtn.addEventListener("click", undoLast);
    actions.insertBefore(undoBtn, actions.firstChild);

    // Commissioner sign-in / sign-out (hidden in local-only mode).
    const authBtn = document.createElement("button");
    authBtn.id = "btn-auth";
    authBtn.className = "btn";
    authBtn.hidden = true;
    authBtn.textContent = "✎ Commissioner sign-in";
    authBtn.addEventListener("click", () => {
      if (sync.role === "commish" || sync.user) signOutCommish();
      else signInCommish();
    });
    actions.insertBefore(authBtn, actions.firstChild);

    // Role/connection badge (hidden in local-only mode).
    const badge = document.createElement("span");
    badge.id = "role-badge";
    badge.hidden = true;
    actions.insertBefore(badge, actions.firstChild);

    // "Waiting for the commissioner" banner for viewers before the draft seeds.
    const banner = document.createElement("div");
    banner.id = "waiting-banner";
    banner.className = "waiting-banner";
    banner.hidden = true;
    banner.textContent = "Waiting for the commissioner to start the draft…";
    (document.querySelector("#tabs") || document.querySelector("main")).before(banner);

    document.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => setTab(b.dataset.tab))
    );
    const udSearch = $("#undrafted-search");
    if (udSearch) udSearch.addEventListener("input", renderUndrafted);

    $("#team-select").addEventListener("change", (e) => setActiveTeam(e.target.value));
    $("#btn-next-team").addEventListener("click", () => stepTeam(1));
    $("#btn-prev-team").addEventListener("click", () => stepTeam(-1));
    $("#btn-shuffle").addEventListener("click", shuffleOrder);
    $("#player-search").addEventListener("input", renderBoard);

    $("#auction-form").addEventListener("submit", submitAuction);
    $("#auction-bid").addEventListener("input", () => {
      if (nominated) { nominated.bid = parseInt($("#auction-bid").value, 10) || 0; setNomination(nominated); }
    });
    $("#auction-cancel").addEventListener("click", closeAuction);
    $("#auction-modal").addEventListener("click", (e) => {
      if (e.target.id === "auction-modal") closeAuction();
    });

    $("#roster-close").addEventListener("click", closeRoster);
    $("#roster-modal").addEventListener("click", (e) => {
      if (e.target.id === "roster-modal") closeRoster();
    });

    // Keeper modal: populate the manual-add club/position pickers once, then wire.
    const kTeam = $("#keeper-custom-team");
    if (kTeam) {
      kTeam.add(new Option("Club…", ""));
      TEAMS.slice().sort((a, b) => a.name.localeCompare(b.name))
        .forEach((t) => kTeam.add(new Option(`${t.name} (${t.abbr})`, t.abbr)));
    }
    const kPos = $("#keeper-custom-pos");
    if (kPos) {
      kPos.add(new Option("Pos…", ""));
      POSITION_ORDER.forEach((pos) => kPos.add(new Option(pos, pos)));
    }
    $("#keeper-form").addEventListener("submit", submitKeeper);
    $("#keeper-cancel").addEventListener("click", closeKeeperModal);
    $("#keeper-modal").addEventListener("click", (e) => {
      if (e.target.id === "keeper-modal") closeKeeperModal();
    });
    $("#keeper-search").addEventListener("input", () => populateKeeperPlayers($("#keeper-search").value));
    $("#keeper-player").addEventListener("change", applyKeeperSuggestion);
    $("#keeper-custom-toggle").addEventListener("change", () => {
      const on = $("#keeper-custom-toggle").checked;
      $("#keeper-custom").hidden = !on;
      $("#keeper-pool").hidden = on;
      applyKeeperSuggestion();
    });
    ["#keeper-custom-name", "#keeper-custom-team", "#keeper-custom-pos"].forEach((sel) =>
      $(sel).addEventListener("input", applyKeeperSuggestion)
    );
    document.querySelectorAll('input[name="keeper-year"]').forEach((r) =>
      r.addEventListener("change", updateKeeperYearUI)
    );
    $("#keeper-undrafted").addEventListener("change", updateKeeperYearUI);
    $("#keeper-prior").addEventListener("input", updateKeeperComputed);
    $("#keeper-espn").addEventListener("input", () => {
      $("#keeper-espn").dataset.auto = ""; // user typed → stop auto-filling from ESPN
      updateKeeperComputed();
    });
    $("#btn-clear-keepers").addEventListener("click", clearKeepers);
    loadEspnCache(); // ESPN live-salary cache (refreshed lazily when Keepers opens)

    $("#btn-export").addEventListener("click", exportDraft);
    $("#btn-import").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", (e) => {
      if (e.target.files[0]) importDraft(e.target.files[0]);
      e.target.value = "";
    });
    $("#btn-reset").addEventListener("click", resetDraft);
    $("#btn-publish").addEventListener("click", publishToLeague);

    $("#btn-tv").addEventListener("click", () => toggleTvMode());
    try {
      if (localStorage.getItem("cas_tv") === "1") {
        document.body.classList.add("tv-mode");
        $("#btn-tv").textContent = "📺 Exit TV Mode";
      }
    } catch (e) {}

    $("#btn-print-results").addEventListener("click", printResults);
    $("#celebrate-print").addEventListener("click", printResults);
    $("#celebrate-recap").addEventListener("click", () => { $("#celebrate").hidden = true; setTab("recap"); });
    $("#celebrate-close").addEventListener("click", () => { $("#celebrate").hidden = true; });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeAuction(); closeRoster(); closeKeeperModal(); }
    });

    // Announcement-voice dropdown (per-device, saved to localStorage).
    const voiceSel = $("#voice-select");
    if (voiceSel) {
      populateVoices();
      if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = populateVoices;
      if (!("speechSynthesis" in window) && !elevenConfigured()) {
        voiceSel.hidden = true;
      }
      voiceSel.addEventListener("change", () => {
        try { localStorage.setItem("cas_voice", voiceSel.value); } catch (e) {}
        if (voiceSel.value !== "__off__") {
          const sample = PLAYERS.filter((p) => Number.isFinite(p.rank)).sort((a, b) => a.rank - b.rank)[0];
          speak((sample ? sample.name : "This player") + " is on the block"); // preview the voice
        }
      });
    }

    render();
    initSync();      // sets role; viewers/commish connect to Firebase if configured
    applyRoleUI();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
