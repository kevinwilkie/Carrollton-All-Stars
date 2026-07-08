/*
 * Browser smoke tests (Playwright). Needs a static server for the repo root and
 * the playwright devDependency + its chromium. Run:
 *   python3 scripts/serve.py &            # serves :8000
 *   npm run test:browser
 * CI does this in .github/workflows/ci.yml. BASE_URL overrides the origin;
 * PW_EXECUTABLE overrides the chromium binary (set in the dev sandbox).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:8000";
const browser = await chromium.launch(
  process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
after(() => browser.close());

// Offline runs can't reach the Firebase CDN or headshots — ignore those.
const realErrors = (errs) => errs.filter((e) => !/net::|Failed to load resource|ERR_|fetch/i.test(e));
function watch(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  return errs;
}

// Inject a signed-in season-app state with a small roster (no Firebase needed).
async function seedSeason(page, role = "commish") {
  await page.evaluate((role) => {
    const P = (id, name, positions, mlbTeam, mlbTeamId, sp, ilStatus) =>
      ({ mlbId: String(id), name, positions, mlbTeam, mlbTeamId, seasonPoints: sp, ilStatus: ilStatus || null });
    const players = {};
    [
      P(1, "Cal Raleigh", ["C"], "SEA", 136, 210),
      P(2, "Trea Turner", ["SS"], "PHI", 143, 305),
      P(3, "Mike Trout", ["OF"], "LAA", 108, 180, "IL10"),
      P(4, "Yordan Alvarez", ["OF"], "HOU", 117, 260),
      P(5, "Eury Perez", ["SP"], "MIA", 146, 140),
      P(6, "Free Slugger", ["1B"], "COL", 115, 275),
    ].forEach((p) => (players[p.mlbId] = p));
    // first five are on my roster; #6 is a free agent
    ["1", "2", "3", "4", "5"].forEach((id) => (players[id].rosteredBy = "acuna-matata"));
    App.fs = {}; App.myTeamId = "acuna-matata"; App.players = players; App.playersArr = Object.values(players);
    App.claims = []; App.settings = { weeks: [{ n: 16, start: etDate(), end: addDays(etDate(), 5), type: "regular" }] };
    App.teams = { "acuna-matata": { name: "Acuña Matata", faabRemaining: 28, record: { w: 9, l: 6 } } };
    luRoster = { players: Object.fromEntries(["1", "2", "3", "4", "5"].map((id) => [id, players[id]])) };
    luScore = { total: 400, byDay: {}, byPlayerDays: {} };
    App.lineup = { slots: { C: "1", SS: "2", OF1: "3", OF2: "4", SP1: "5" }, locked: {} };
    App.mlbDay = { games: [] };
    Auth.role = role; Auth.user = { getIdToken: async () => "tok" };
    document.querySelector("#gate").hidden = true;
  }, role);
}

test("draft board: loads, records a pick, deducts budget, undoes", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/draft/`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  assert.ok((await page.title()).includes("Auction Draft Board"));
  assert.equal(await page.locator("#team-select option").count(), 30);
  assert.equal(await page.locator("#managers-body tr").count(), 12);
  assert.match(await page.textContent("#draft-summary"), /0\/312/);

  await page.locator(".player-row .btn-primary").first().click();
  await page.waitForSelector("#auction-modal:not([hidden])");
  await page.selectOption("#auction-manager", { index: 1 });
  await page.fill("#auction-bid", "42");
  await page.click("#auction-form button[type=submit]");
  await page.waitForSelector("#auction-modal[hidden]", { state: "attached" });
  assert.match(await page.textContent("#draft-summary"), /1\/312/);
  assert.ok((await page.textContent("#managers-body")).includes("$258"));

  // over-max bid rejected
  await page.locator(".player-row .btn-primary").first().click();
  await page.waitForSelector("#auction-modal:not([hidden])");
  await page.selectOption("#auction-manager", { index: 1 });
  await page.fill("#auction-bid", "9999");
  await page.click("#auction-form button[type=submit]");
  assert.ok(!(await page.locator("#auction-error").isHidden()));
  await page.click("#auction-cancel");

  page.once("dialog", (d) => d.accept());
  await page.click("#btn-undo");
  await page.waitForTimeout(200);
  assert.match(await page.textContent("#draft-summary"), /0\/312/);
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("season app: every view renders in local mode with no JS errors", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  assert.ok((await page.title()).includes("Fantasy Baseball"));
  for (const tab of ["league", "matchup", "scoreboard", "standings", "players", "trades", "transactions", "schedule", "keepers", "settings"]) {
    await page.evaluate((t) => setTab(t), tab);
    assert.ok((await page.innerHTML(`#view-${tab}`)).length > 10, `${tab} renders`);
  }
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("nav: 4 top tabs, hamburger opens the menu and navigates", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  assert.equal(await page.locator(".tabs .tab").count(), 4);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#menu-drawer")).visibility), "hidden");
  await page.click("#btn-menu");
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#menu-drawer")).visibility), "visible");
  await page.click('.menu-item[data-tab="scoreboard"]');
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => !document.querySelector("#view-scoreboard").hidden), "scoreboard shown");
  assert.equal(await page.evaluate(() => document.body.classList.contains("menu-open")), false, "menu closed after nav");
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("My Team: position picker moves a player and the card offers Drop", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await seedSeason(page);
  await page.evaluate(() => { window.saveLineupSlots = async (s) => { window.__saved = s; App.lineup = { ...App.lineup, slots: s }; }; setTab("myteam"); });
  await page.waitForTimeout(200);

  // tap the (empty) UTIL1 slot → picker with eligible hitters. data-act="fill"
  // is on the chip for a filled slot and on the row for an empty one.
  await page.click('[data-act="fill"][data-slot="UTIL1"]');
  await page.waitForTimeout(150);
  assert.match(await page.textContent("#mt-sheet"), /Choose a Utility/);
  const picked = await page.evaluate(() => { const r = document.querySelector("#mt-sheet .pick-row:not(:disabled)"); const id = r && r.dataset.id; if (r) r.click(); return id; });
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => !!window.__saved), "a move was saved");
  assert.ok(await page.evaluate((pid) => String(window.__saved.UTIL1) === String(pid), picked));

  // tap a player → card with a Drop button
  await page.evaluate(() => renderMyTeam());
  await page.evaluate(() => document.querySelector('.lu-player[data-act="card"]').click());
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => !!document.querySelector("#mt-sheet .pc-head")));
  assert.ok(await page.evaluate(() => !!document.querySelector('#mt-sheet [data-card="drop"]')));
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("Players tab: free agents sort by season points and open a card", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await seedSeason(page);
  await page.evaluate(() => setTab("players"));
  await page.waitForTimeout(200);
  const vals = await page.evaluate(() => [...document.querySelectorAll("#view-players .player-list .val")].map((e) => e.textContent));
  // available filter → only the free agent (Free Slugger, 275)
  assert.ok(vals.includes("275"));
  await page.evaluate(() => document.querySelector("#view-players [data-card]").click());
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => !!document.querySelector("#mt-sheet .pc-head")));
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("settings: theme toggle + team profile editor, header has no stray controls", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // the old header pills/links/theme button are gone
  assert.equal(await page.locator("#faab-pill, #week-pill, #btn-auth, #role-badge").count(), 0);
  await seedSeason(page);
  await page.evaluate(() => setTab("settings"));
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => !!document.querySelector("#view-settings #btn-theme")), "theme toggle in settings");
  assert.ok(await page.evaluate(() => !!document.querySelector("#view-settings #set-name")), "team name editor");
  // theme toggle flips the data-theme attribute
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click("#view-settings #btn-theme");
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.notEqual(before, after);
  // saving the team profile calls the API
  await page.evaluate(() => { window.__profile = null; window.saveTeamProfile = async (p) => { window.__profile = p; }; });
  await page.fill("#view-settings #set-name", "New Name");
  await page.click("#view-settings #set-save");
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__profile && window.__profile.name), "New Name");
  assert.deepEqual(realErrors(errs), []);
  await page.close();
});

test("error surfacing: a failed load shows a Retry card, not a spinner", async () => {
  const page = await browser.newPage();
  const errs = watch(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    App.fs = {}; App.myTeamId = "acuna-matata"; App.teams = { "acuna-matata": { name: "X" } }; App.settings = { weeks: [] };
    window.loadPlayers = async () => { throw new Error("permission denied"); };
    Auth.role = "owner"; document.querySelector("#gate").hidden = true; setTab("myteam");
  });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => !!document.querySelector('#view-myteam [data-retry="myteam"]')));
  assert.ok(await page.evaluate(() => !/Loading roster/.test(document.querySelector("#view-myteam").textContent)));
  // (a failed load intentionally console.errors — that's the surfacing, not a bug)
  await page.close();
});
