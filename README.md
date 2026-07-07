# Carrollton All-Stars ⚾

The complete home of our 12-team fantasy baseball league: a live **auction draft board**
(the League of Dreams experience, remade for MLB) plus a full **season platform** —
daily lineups, head-to-head points matchups, FAAB waivers, trades with league veto,
standings, and playoffs.

**No build step.** Plain HTML/CSS/JS deployed to Netlify, with Firebase for sign-in and
live data, and three scheduled Netlify functions doing the daily work. Player data and
box scores come from the free MLB Stats API (statsapi.mlb.com).

| Where | What |
| --- | --- |
| `/` (site root) | Season app — My Team, Matchup, Scoreboard, Standings, Players, Trades, Transactions, Schedule, Keepers, Admin |
| `/draft/` | Auction draft board — hat-twist nominations, live sync, TTS announcer, keepers |
| `shared/` | League config (owners, rules, scoring), theme, auth, scoring engine — one source of truth |
| `netlify/functions/` | `ingest-stats` (every 30 min), `daily-rollover` (~3am ET), `hourly-tick` |
| `scripts/` | Commissioner tools: player pool builder, schedule generator, season replay/backtest |

**New here? Start with [SETUP.md](SETUP.md).**

## League rules at a glance

- **Format:** 12 teams · H2H points · daily lineups (players lock at their game's first pitch)
- **Season:** 21-week balanced round-robin → top 6 playoff over the final 3 weeks (1–2 seeds bye)
- **Roster (30):** C · 1B · 2B · 3B · SS · INF · OF×4 · UTIL×2 · SP×4 · RP×4 · 6 bench · 4 IL (real MLB IL only)
- **Scoring — hitters:** 1B 1 · 2B 2 · 3B 3 · HR 4 · BB 1 · IBB +1 · R 1 · RBI 1 · SB 2 · K −1
- **Scoring — pitchers:** IP 3/inning · K 1 · W 2 · QS 5 · SV 5 · HLD 2 · CG 3 · SHO 3 · ER −2 · H −1 · BB −1
- **Pitching cap:** only the first **7 pitcher starts** count per scoring week (counted in game order; extra starts score zero)
- **Draft:** $300 auction, 26 spots, hat-twist nominations by MLB club
- **Waivers:** daily FAAB, $100/season, $1 minimum, processed ~3am ET (ties → worse record)
- **Trades:** 1-day review; blocked only by 6+ vetoes from the other 10 owners
- **Keepers:** up to 5 · Y1 = price+$5 ($5 undrafted) · Y2 = ESPN avg salary · max 2 straight years
- **Two-way players** (Ohtani) split Yahoo-style into separate Batter and Pitcher entries — different teams can own each half (list in `shared/league-config.js` `TWO_WAY_PLAYERS`)

Change a rule → edit `shared/league-config.js` (and `firestore.rules` if owners change).

## Development

```bash
python3 scripts/serve.py          # http://localhost:8000 (season app) and /draft/
node scripts/build_player_pool.mjs    # refresh draft/data/players.js from MLB
node scripts/generate_schedule.mjs    # print/emit the 21-week schedule
node scripts/replay_season.mjs --date 2026-06-15   # score a real MLB day (backtest)
```

Without `FIREBASE_CONFIG` set (see SETUP.md), the draft board runs local-only
(saves to your browser) and the season app shows demo data — enough to develop against.

## Known trade-offs

- **MLB Stats API is unofficial.** It's been stable for years, but fields can shift;
  `netlify/functions/lib/mlb.js` is the single adapter, and raw stat payloads are kept
  in Firestore so points can be recomputed after any fix.
- **ESPN average-salary fetch** (Year-2 keeper prices) is a fragile public endpoint;
  the keeper modal always allows manual entry.
- **Lineup locks** are snapshotted by the 30-minute ingest job; the UI blocks editing
  locked players immediately, but a technically savvy owner has a ≤30-min window before
  the snapshot. The transaction log + commissioner override cover a friends league.
- **Waiver time shifts with DST** (3:10am EST / 4:10am EDT) — Netlify crons are UTC.
- Free tiers (Firebase Spark, Netlify) hold comfortably for 12 users; the season app
  reads precomputed aggregate docs rather than raw stat lines to keep reads low.
