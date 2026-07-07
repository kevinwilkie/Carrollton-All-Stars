/*
 * Carrollton All-Stars — Draft Player Pool
 * ---------------------------------------------------------------------------
 * ⚠️ PLACEHOLDER DATA (a ~120-player sample, 2026-era rosters) so the board
 * works out of the box. Before the real draft, REGENERATE the full ~700-player
 * pool from the MLB Stats API:
 *
 *     node scripts/build_player_pool.mjs --season 2026 --out draft/data/players.js
 *
 * Format (one line per player):
 *   { id: <mlbId>, name, team: <abbr from mlb-teams.js>, positions: [primary, …], rank }
 * `rank` orders the Undrafted tab (lower = better), computed by the builder
 * from last season's fantasy points under OUR scoring. Hand-added players may
 * omit it. Headshots come from the mlbId — no photo file needed.
 */
const PLAYERS = [
  // ---- Arizona Diamondbacks (ARI) ----
  { id: 682998, name: "Corbin Carroll", team: "ARI", positions: ["OF"], rank: 9 },
  { id: 668939, name: "Ketel Marte", team: "ARI", positions: ["2B"], rank: 22 },
  { id: 686668, name: "Gabriel Moreno", team: "ARI", positions: ["C"], rank: 120 },
  { id: 668678, name: "Zac Gallen", team: "ARI", positions: ["SP"], rank: 78 },
  // ---- Athletics (ATH) ----
  { id: 683021, name: "Lawrence Butler", team: "ATH", positions: ["OF"], rank: 70 },
  { id: 808963, name: "Jacob Wilson", team: "ATH", positions: ["SS"], rank: 105 },
  { id: 683232, name: "Tyler Soderstrom", team: "ATH", positions: ["1B", "C"], rank: 130 },
  { id: 672335, name: "Mason Miller", team: "ATH", positions: ["RP"], rank: 90 },
  // ---- Atlanta Braves (ATL) ----
  { id: 660670, name: "Ronald Acuña Jr.", team: "ATL", positions: ["OF"], rank: 6 },
  { id: 663586, name: "Austin Riley", team: "ATL", positions: ["3B"], rank: 45 },
  { id: 621566, name: "Matt Olson", team: "ATL", positions: ["1B"], rank: 38 },
  { id: 675911, name: "Spencer Strider", team: "ATL", positions: ["SP"], rank: 40 },
  { id: 672515, name: "Chris Sale", team: "ATL", positions: ["SP"], rank: 55 },
  // ---- Baltimore Orioles (BAL) ----
  { id: 668939, name: "Gunnar Henderson", team: "BAL", positions: ["SS"], rank: 8 },
  { id: 683002, name: "Adley Rutschman", team: "BAL", positions: ["C"], rank: 60 },
  { id: 686283, name: "Jackson Holliday", team: "BAL", positions: ["2B"], rank: 85 },
  { id: 669084, name: "Felix Bautista", team: "BAL", positions: ["RP"], rank: 95 },
  // ---- Boston Red Sox (BOS) ----
  { id: 807799, name: "Roman Anthony", team: "BOS", positions: ["OF"], rank: 50 },
  { id: 646240, name: "Alex Bregman", team: "BOS", positions: ["3B"], rank: 25 },
  { id: 676979, name: "Garrett Crochet", team: "BOS", positions: ["SP"], rank: 20 },
  { id: 678882, name: "Jarren Duran", team: "BOS", positions: ["OF"], rank: 65 },
  // ---- Chicago Cubs (CHC) ----
  { id: 683357, name: "Pete Crow-Armstrong", team: "CHC", positions: ["OF"], rank: 18 },
  { id: 664023, name: "Kyle Tucker", team: "CHC", positions: ["OF"], rank: 12 },
  { id: 665871, name: "Seiya Suzuki", team: "CHC", positions: ["OF", "DH"], rank: 58 },
  { id: 669372, name: "Shota Imanaga", team: "CHC", positions: ["SP"], rank: 72 },
  // ---- Chicago White Sox (CWS) ----
  { id: 673357, name: "Luis Robert Jr.", team: "CWS", positions: ["OF"], rank: 110 },
  { id: 686797, name: "Colson Montgomery", team: "CWS", positions: ["SS"], rank: 160 },
  { id: 700360, name: "Kyle Teel", team: "CWS", positions: ["C"], rank: 170 },
  { id: 681432, name: "Shane Smith", team: "CWS", positions: ["SP"], rank: 190 },
  // ---- Cincinnati Reds (CIN) ----
  { id: 682829, name: "Elly De La Cruz", team: "CIN", positions: ["SS"], rank: 5 },
  { id: 680574, name: "Hunter Greene", team: "CIN", positions: ["SP"], rank: 35 },
  { id: 671096, name: "Andrew Abbott", team: "CIN", positions: ["SP"], rank: 115 },
  { id: 668715, name: "Tyler Stephenson", team: "CIN", positions: ["C"], rank: 150 },
  // ---- Cleveland Guardians (CLE) ----
  { id: 608070, name: "José Ramírez", team: "CLE", positions: ["3B"], rank: 7 },
  { id: 680757, name: "Steven Kwan", team: "CLE", positions: ["OF"], rank: 88 },
  { id: 661403, name: "Emmanuel Clase", team: "CLE", positions: ["RP"], rank: 75 },
  { id: 693433, name: "Gavin Williams", team: "CLE", positions: ["SP"], rank: 140 },
  // ---- Colorado Rockies (COL) ----
  { id: 663898, name: "Ezequiel Tovar", team: "COL", positions: ["SS"], rank: 125 },
  { id: 686613, name: "Brenton Doyle", team: "COL", positions: ["OF"], rank: 135 },
  { id: 662197, name: "Hunter Goodman", team: "COL", positions: ["C", "OF"], rank: 145 },
  { id: 676051, name: "Chase Dollander", team: "COL", positions: ["SP"], rank: 260 },
  // ---- Detroit Tigers (DET) ----
  { id: 669373, name: "Tarik Skubal", team: "DET", positions: ["SP"], rank: 10 },
  { id: 682985, name: "Riley Greene", team: "DET", positions: ["OF"], rank: 42 },
  { id: 668939, name: "Spencer Torkelson", team: "DET", positions: ["1B"], rank: 118 },
  { id: 683068, name: "Colt Keith", team: "DET", positions: ["2B", "1B"], rank: 155 },
  // ---- Houston Astros (HOU) ----
  { id: 670541, name: "Yordan Alvarez", team: "HOU", positions: ["DH", "OF"], rank: 16 },
  { id: 665161, name: "Jeremy Peña", team: "HOU", positions: ["SS"], rank: 68 },
  { id: 664299, name: "Isaac Paredes", team: "HOU", positions: ["3B", "1B"], rank: 92 },
  { id: 686613, name: "Hunter Brown", team: "HOU", positions: ["SP"], rank: 28 },
  { id: 661527, name: "Josh Hader", team: "HOU", positions: ["RP"], rank: 62 },
  // ---- Kansas City Royals (KC) ----
  { id: 677951, name: "Bobby Witt Jr.", team: "KC", positions: ["SS"], rank: 2 },
  { id: 686469, name: "Vinnie Pasquantino", team: "KC", positions: ["1B"], rank: 80 },
  { id: 663460, name: "Salvador Perez", team: "KC", positions: ["C", "1B"], rank: 112 },
  { id: 669022, name: "Cole Ragans", team: "KC", positions: ["SP"], rank: 33 },
  // ---- Los Angeles Angels (LAA) ----
  { id: 545361, name: "Mike Trout", team: "LAA", positions: ["OF", "DH"], rank: 74 },
  { id: 700242, name: "Zach Neto", team: "LAA", positions: ["SS"], rank: 82 },
  { id: 690953, name: "Logan O'Hoppe", team: "LAA", positions: ["C"], rank: 132 },
  { id: 681351, name: "Reid Detmers", team: "LAA", positions: ["SP", "RP"], rank: 240 },
  // ---- Los Angeles Dodgers (LAD) ----
  { id: "660271:B", name: "Shohei Ohtani (Batter)", team: "LAD", positions: ["DH"], rank: 1 },
  { id: "660271:P", name: "Shohei Ohtani (Pitcher)", team: "LAD", positions: ["SP"], rank: 30 },
  { id: 605141, name: "Mookie Betts", team: "LAD", positions: ["SS", "OF"], rank: 14 },
  { id: 518692, name: "Freddie Freeman", team: "LAD", positions: ["1B"], rank: 30 },
  { id: 669257, name: "Will Smith", team: "LAD", positions: ["C"], rank: 64 },
  { id: 808967, name: "Yoshinobu Yamamoto", team: "LAD", positions: ["SP"], rank: 24 },
  { id: 669160, name: "Tyler Glasnow", team: "LAD", positions: ["SP"], rank: 96 },
  // ---- Miami Marlins (MIA) ----
  { id: 665862, name: "Sandy Alcantara", team: "MIA", positions: ["SP"], rank: 98 },
  { id: 691587, name: "Xavier Edwards", team: "MIA", positions: ["SS", "2B"], rank: 108 },
  { id: 683446, name: "Kyle Stowers", team: "MIA", positions: ["OF"], rank: 128 },
  { id: 694297, name: "Eury Pérez", team: "MIA", positions: ["SP"], rank: 102 },
  // ---- Milwaukee Brewers (MIL) ----
  { id: 686217, name: "Jackson Chourio", team: "MIL", positions: ["OF"], rank: 15 },
  { id: 668930, name: "William Contreras", team: "MIL", positions: ["C"], rank: 48 },
  { id: 682842, name: "Brice Turang", team: "MIL", positions: ["2B"], rank: 86 },
  { id: 776039, name: "Jacob Misiorowski", team: "MIL", positions: ["SP"], rank: 66 },
  { id: 661383, name: "Trevor Megill", team: "MIL", positions: ["RP"], rank: 122 },
  // ---- Minnesota Twins (MIN) ----
  { id: 668904, name: "Byron Buxton", team: "MIN", positions: ["OF"], rank: 52 },
  { id: 682611, name: "Royce Lewis", team: "MIN", positions: ["3B"], rank: 138 },
  { id: 663616, name: "Joe Ryan", team: "MIN", positions: ["SP"], rank: 44 },
  { id: 682126, name: "Jhoan Duran", team: "MIN", positions: ["RP"], rank: 100 },
  // ---- New York Mets (NYM) ----
  { id: 665742, name: "Juan Soto", team: "NYM", positions: ["OF"], rank: 4 },
  { id: 624413, name: "Pete Alonso", team: "NYM", positions: ["1B"], rank: 26 },
  { id: 682626, name: "Francisco Lindor", team: "NYM", positions: ["SS"], rank: 11 },
  { id: 663855, name: "Brandon Nimmo", team: "NYM", positions: ["OF"], rank: 116 },
  { id: 693312, name: "Edwin Díaz", team: "NYM", positions: ["RP"], rank: 84 },
  // ---- New York Yankees (NYY) ----
  { id: 592450, name: "Aaron Judge", team: "NYY", positions: ["OF"], rank: 3 },
  { id: 665487, name: "Cody Bellinger", team: "NYY", positions: ["OF", "1B"], rank: 56 },
  { id: 683011, name: "Jazz Chisholm Jr.", team: "NYY", positions: ["2B", "3B"], rank: 34 },
  { id: 701542, name: "Ben Rice", team: "NYY", positions: ["C", "1B", "DH"], rank: 94 },
  { id: 543037, name: "Gerrit Cole", team: "NYY", positions: ["SP"], rank: 76 },
  { id: 662253, name: "Max Fried", team: "NYY", positions: ["SP"], rank: 46 },
  // ---- Philadelphia Phillies (PHI) ----
  { id: 547180, name: "Bryce Harper", team: "PHI", positions: ["1B"], rank: 21 },
  { id: 607208, name: "Trea Turner", team: "PHI", positions: ["SS"], rank: 17 },
  { id: 656941, name: "Kyle Schwarber", team: "PHI", positions: ["DH", "OF"], rank: 23 },
  { id: 554430, name: "Zack Wheeler", team: "PHI", positions: ["SP"], rank: 19 },
  { id: 605400, name: "Aaron Nola", team: "PHI", positions: ["SP"], rank: 124 },
  // ---- Pittsburgh Pirates (PIT) ----
  { id: 694973, name: "Paul Skenes", team: "PIT", positions: ["SP"], rank: 13 },
  { id: 665833, name: "Oneil Cruz", team: "PIT", positions: ["OF", "SS"], rank: 54 },
  { id: 668804, name: "Bryan Reynolds", team: "PIT", positions: ["OF"], rank: 142 },
  { id: 692225, name: "David Bednar", team: "PIT", positions: ["RP"], rank: 148 },
  // ---- San Diego Padres (SD) ----
  { id: 665487, name: "Fernando Tatis Jr.", team: "SD", positions: ["OF"], rank: 29 },
  { id: 592518, name: "Manny Machado", team: "SD", positions: ["3B"], rank: 51 },
  { id: 673490, name: "Jackson Merrill", team: "SD", positions: ["OF"], rank: 59 },
  { id: 663158, name: "Dylan Cease", team: "SD", positions: ["SP"], rank: 89 },
  { id: 674003, name: "Robert Suarez", team: "SD", positions: ["RP"], rank: 136 },
  // ---- San Francisco Giants (SF) ----
  { id: 646240, name: "Rafael Devers", team: "SF", positions: ["1B", "DH"], rank: 27 },
  { id: 665019, name: "Willy Adames", team: "SF", positions: ["SS"], rank: 104 },
  { id: 693049, name: "Logan Webb", team: "SF", positions: ["SP"], rank: 57 },
  { id: 671737, name: "Ryan Walker", team: "SF", positions: ["RP"], rank: 178 },
  // ---- Seattle Mariners (SEA) ----
  { id: 663728, name: "Cal Raleigh", team: "SEA", positions: ["C"], rank: 31 },
  { id: 677594, name: "Julio Rodríguez", team: "SEA", positions: ["OF"], rank: 32 },
  { id: 669302, name: "Logan Gilbert", team: "SEA", positions: ["SP"], rank: 61 },
  { id: 682243, name: "Bryan Woo", team: "SEA", positions: ["SP"], rank: 71 },
  { id: 669923, name: "Andrés Muñoz", team: "SEA", positions: ["RP"], rank: 106 },
  // ---- St. Louis Cardinals (STL) ----
  { id: 691026, name: "Masyn Winn", team: "STL", positions: ["SS"], rank: 114 },
  { id: 680977, name: "Brendan Donovan", team: "STL", positions: ["2B", "OF"], rank: 126 },
  { id: 668227, name: "Willson Contreras", team: "STL", positions: ["1B", "C"], rank: 134 },
  { id: 668984, name: "Sonny Gray", team: "STL", positions: ["SP"], rank: 152 },
  // ---- Tampa Bay Rays (TB) ----
  { id: 668227, name: "Junior Caminero", team: "TB", positions: ["3B"], rank: 36 },
  { id: 677551, name: "Carson Williams", team: "TB", positions: ["SS"], rank: 168 },
  { id: 664126, name: "Yandy Díaz", team: "TB", positions: ["1B", "DH"], rank: 146 },
  { id: 693713, name: "Shane McClanahan", team: "TB", positions: ["SP"], rank: 158 },
  // ---- Texas Rangers (TEX) ----
  { id: 608369, name: "Corey Seager", team: "TEX", positions: ["SS"], rank: 41 },
  { id: 543760, name: "Marcus Semien", team: "TEX", positions: ["2B"], rank: 119 },
  { id: 694497, name: "Wyatt Langford", team: "TEX", positions: ["OF"], rank: 43 },
  { id: 592662, name: "Jacob deGrom", team: "TEX", positions: ["SP"], rank: 63 },
  { id: 665489, name: "Nathan Eovaldi", team: "TEX", positions: ["SP"], rank: 121 },
  // ---- Toronto Blue Jays (TOR) ----
  { id: 665489, name: "Vladimir Guerrero Jr.", team: "TOR", positions: ["1B"], rank: 37 },
  { id: 666182, name: "Bo Bichette", team: "TOR", positions: ["SS"], rank: 69 },
  { id: 641856, name: "George Springer", team: "TOR", positions: ["OF", "DH"], rank: 111 },
  { id: 579328, name: "Kevin Gausman", team: "TOR", positions: ["SP"], rank: 129 },
  { id: 661563, name: "Jeff Hoffman", team: "TOR", positions: ["RP"], rank: 165 },
  // ---- Washington Nationals (WSH) ----
  { id: 682928, name: "James Wood", team: "WSH", positions: ["OF"], rank: 39 },
  { id: 671277, name: "CJ Abrams", team: "WSH", positions: ["SS"], rank: 53 },
  { id: 695578, name: "Dylan Crews", team: "WSH", positions: ["OF"], rank: 141 },
  { id: 680686, name: "MacKenzie Gore", team: "WSH", positions: ["SP"], rank: 93 },
];
