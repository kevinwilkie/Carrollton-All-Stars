# Setting up Carrollton All-Stars (one-time, ~45 minutes)

This wires up the three accounts you already have — **Firebase** (sign-in + data),
**Netlify** (hosting + the scheduled jobs), and **GitHub** (this repo). Do the steps in
order; nothing here requires a terminal except step 6's one command.

---

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project** → name it `carrollton-allstars`
   (Analytics optional → off is fine).
2. **Build → Realtime Database → Create Database** (US location, **test mode** for now).
   This powers the live draft board.
3. **Build → Firestore Database → Create database** (production mode, US location).
   This holds everything for the season: rosters, lineups, scores, waivers, trades.
4. **Build → Authentication → Get started → Sign-in method → Google → Enable**
   (pick your email as support email) → Save.

## 2. Register the web app + paste the config

1. Project **⚙ settings → Your apps → Web (`</>`)** → nickname `carrollton` →
   **Register app** (skip Firebase Hosting).
2. Copy the `firebaseConfig = { … }` object it shows.
3. In this repo, open **`shared/firebase-init.js`** and set `FIREBASE_CONFIG` to that
   object. Make sure it includes `databaseURL` — if it doesn't, copy the URL from the
   Realtime Database page (looks like `https://carrollton-allstars-default-rtdb.firebaseio.com`)
   and add it as `databaseURL: "…"`.

## 3. Fill in the owners

1. **`shared/league-config.js`** → replace each `TODO-…@example.com` with the Google
   email that owner will sign in with (ask each owner which Gmail/Google account they use).
   This is the **single source** — you do *not* edit `firestore.rules` for owners.
2. Commit + push (Netlify redeploys automatically once step 5 is done).
3. Later, after the site is live and you've signed in as commissioner, run
   **Admin → Seed teams** (setup step 7). That writes each owner's email onto their team
   *and* the `config/members` allowlist the security rules read. **Re-run Seed teams
   whenever you add or change a real owner email** — that's what activates their access.
   (Owners still on a `TODO-` placeholder are skipped until you fill in a real address.)

## 4. Publish the database rules

1. **Realtime Database → Rules** → paste the contents of **`database.rules.json`** →
   **Publish**. (Draft board: anyone can watch, only you can write.)
2. **Firestore → Rules** → paste the contents of **`firestore.rules`** → **Publish**.
3. **Authentication → Settings → Authorized domains → Add domain** → add your Netlify
   site domain from step 5 (e.g. `carrollton-all-stars.netlify.app`). `localhost` is
   already allowed for testing.

## 5. Netlify site

1. <https://app.netlify.com> → **Add new site → Import an existing project** → GitHub →
   pick `kevinwilkie/Carrollton-All-Stars`.
2. Build settings are read from `netlify.toml` automatically (no build command,
   publish = repo root). Deploy.
3. Rename the site to something friendly: **Site configuration → Site details →
   Change site name** (e.g. `carrollton-all-stars`) — then do step 4.3 with that domain.

## 6. Service account for the scheduled jobs

The nightly stats/waivers/trades jobs run on Netlify and need admin access to Firebase:

1. Firebase console → **⚙ Project settings → Service accounts → Generate new private key**
   → a JSON file downloads. **Keep it private — never commit it.**
2. Base64-encode it (Mac/Linux Terminal):
   ```
   base64 -i ~/Downloads/carrollton-allstars-*.json | pbcopy
   ```
   (that copies the encoded text to your clipboard)
3. Netlify → **Site configuration → Environment variables → Add a variable**:
   - `FIREBASE_SERVICE_ACCOUNT_B64` = *paste from clipboard*
   - `FIREBASE_DB_URL` = your Realtime Database URL (from step 2.3)
   - `ALERT_WEBHOOK` *(optional)* = a Slack or Discord incoming-webhook URL. If set, the
     nightly jobs post a one-line alert when a step fails (e.g. waivers didn't run), so a
     silent failure reaches you. Leave it unset to skip alerts.
4. **Deploys → Trigger deploy** so the functions pick up the variables.
5. Check it worked: **Logs → Functions → daily-rollover** should show a successful run
   the next morning (or trigger one from the season app's **Admin** tab → *Run jobs*).

## 7. First sign-in

1. Open your Netlify URL → click **Sign in** → use `kevin.wilkie@campusoutreach.org`.
   You should land on the season app with the commissioner badge.
2. Open **Admin** tab:
   - *Seed teams* — creates the 12 team docs in Firestore from league-config **and** the
     `config/members` allowlist the rules read. Re-run this whenever you fill in a new
     owner email (step 3) to grant that owner access. The toast tells you how many member
     emails were written and how many teams are still on a placeholder.
   - *Generate schedule* — builds the 21-week schedule + playoff weeks (review, save).
   - *Sync players* — first pull of the MLB player universe.
3. Open `/draft/` and sign in there once too — you'll get the green **Commissioner**
   badge; everyone else who opens the link just watches.

---

## Draft day (March)

- Player pool: a week or so before, run `node scripts/build_player_pool.mjs` and commit
  the refreshed `draft/data/players.js` (see that file's header), or ask Claude to.
- Keepers: enter each team's keepers on the draft board's **Keepers** tab before the
  draft (prices auto-check Year 1/Year 2 rules; Year 2 pulls ESPN average salary).
- Draft night: open `/draft/` on the big screen (📺 TV Mode), sign in, draft. Owners
  can watch live from any device — share the plain URL.
- After the final pick: **Publish to League** (top bar) copies every roster into the
  season app, charges the auction prices, and sets everyone's $100 FAAB.

## Every season

- Bump `LEAGUE.season` in `shared/league-config.js` and `SYNC_PATH` in
  `draft/data/draft-config.js`; update `KEEPER.espnDeadline`.
- Regenerate the player pool + schedule (Admin tab).
- The keeper eligibility card fills itself from last season's draft + rosters —
  no imports needed after year one.

## Troubleshooting

- **"Sign-in failed / unauthorized domain"** → step 4.3 (Authorized domains).
- **Owner sees "not part of the league" / their screens are empty** → their Google email
  isn't in the allowlist yet. Put the real address in `shared/league-config.js`, push, then
  run **Admin → Seed teams** to refresh `config/members`. (Editing the file alone isn't
  enough — the seed is what writes the allowlist the rules read.)
- **No stats appearing** → Netlify function logs (step 6.5); most often the env vars
  are missing or the service-account JSON was truncated in copy/paste.
- **Draft board says "local only"** → `FIREBASE_CONFIG` still null in
  `shared/firebase-init.js`, or the CDN scripts are blocked (rare on school/work wifi).
