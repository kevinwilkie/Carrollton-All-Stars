/*
 * Carrollton All-Stars — the 30 MLB clubs
 * ---------------------------------------------------------------------------
 * `id` is the MLB Stats API team id (drives logos + the player pool build);
 * `abbr` is our display abbreviation. Colors re-theme the Draft Board to the
 * club drawn from the hat. Logos come from mlbstatic.com by id (see logo url
 * helper in app.js) — no scraping needed.
 */
const TEAMS = [
  { id: 109, abbr: "ARI", name: "Arizona Diamondbacks" },
  { id: 133, abbr: "ATH", name: "Athletics" },
  { id: 144, abbr: "ATL", name: "Atlanta Braves" },
  { id: 110, abbr: "BAL", name: "Baltimore Orioles" },
  { id: 111, abbr: "BOS", name: "Boston Red Sox" },
  { id: 112, abbr: "CHC", name: "Chicago Cubs" },
  { id: 145, abbr: "CWS", name: "Chicago White Sox" },
  { id: 113, abbr: "CIN", name: "Cincinnati Reds" },
  { id: 114, abbr: "CLE", name: "Cleveland Guardians" },
  { id: 115, abbr: "COL", name: "Colorado Rockies" },
  { id: 116, abbr: "DET", name: "Detroit Tigers" },
  { id: 117, abbr: "HOU", name: "Houston Astros" },
  { id: 118, abbr: "KC",  name: "Kansas City Royals" },
  { id: 108, abbr: "LAA", name: "Los Angeles Angels" },
  { id: 119, abbr: "LAD", name: "Los Angeles Dodgers" },
  { id: 146, abbr: "MIA", name: "Miami Marlins" },
  { id: 158, abbr: "MIL", name: "Milwaukee Brewers" },
  { id: 142, abbr: "MIN", name: "Minnesota Twins" },
  { id: 121, abbr: "NYM", name: "New York Mets" },
  { id: 147, abbr: "NYY", name: "New York Yankees" },
  { id: 143, abbr: "PHI", name: "Philadelphia Phillies" },
  { id: 134, abbr: "PIT", name: "Pittsburgh Pirates" },
  { id: 135, abbr: "SD",  name: "San Diego Padres" },
  { id: 136, abbr: "SEA", name: "Seattle Mariners" },
  { id: 137, abbr: "SF",  name: "San Francisco Giants" },
  { id: 138, abbr: "STL", name: "St. Louis Cardinals" },
  { id: 139, abbr: "TB",  name: "Tampa Bay Rays" },
  { id: 140, abbr: "TEX", name: "Texas Rangers" },
  { id: 141, abbr: "TOR", name: "Toronto Blue Jays" },
  { id: 120, abbr: "WSH", name: "Washington Nationals" },
];

// Default "draw from the hat" order (reshufflable live).
const DRAFT_ORDER = TEAMS.map((t) => t.abbr);

// Official club colors (primary, secondary, optional alt) for board theming.
const TEAM_COLORS = {
  ARI: { primary: "#A71930", secondary: "#E3D4AD", alt: "#30CED8" },
  ATH: { primary: "#003831", secondary: "#EFB21E" },
  ATL: { primary: "#CE1141", secondary: "#13274F" },
  BAL: { primary: "#DF4601", secondary: "#000000" },
  BOS: { primary: "#BD3039", secondary: "#0C2340" },
  CHC: { primary: "#0E3386", secondary: "#CC3433" },
  CWS: { primary: "#27251F", secondary: "#C4CED4" },
  CIN: { primary: "#C6011F", secondary: "#000000" },
  CLE: { primary: "#00385D", secondary: "#E50022" },
  COL: { primary: "#333366", secondary: "#C4CED4", alt: "#131413" },
  DET: { primary: "#0C2340", secondary: "#FA4616" },
  HOU: { primary: "#002D62", secondary: "#EB6E1F" },
  KC:  { primary: "#004687", secondary: "#BD9B60" },
  LAA: { primary: "#BA0021", secondary: "#003263" },
  LAD: { primary: "#005A9C", secondary: "#EF3E42" },
  MIA: { primary: "#00A3E0", secondary: "#EF3340", alt: "#41748D" },
  MIL: { primary: "#12284B", secondary: "#FFC52F" },
  MIN: { primary: "#002B5C", secondary: "#D31145" },
  NYM: { primary: "#002D72", secondary: "#FF5910" },
  NYY: { primary: "#0C2340", secondary: "#C4CED3" },
  PHI: { primary: "#E81828", secondary: "#002D72" },
  PIT: { primary: "#27251F", secondary: "#FDB827" },
  SD:  { primary: "#2F241D", secondary: "#FFC425" },
  SEA: { primary: "#0C2C56", secondary: "#005C5C", alt: "#C4CED4" },
  SF:  { primary: "#FD5A1E", secondary: "#27251F" },
  STL: { primary: "#C41E3A", secondary: "#0C2340", alt: "#FEDB00" },
  TB:  { primary: "#092C5C", secondary: "#8FBCE6", alt: "#F5D130" },
  TEX: { primary: "#003278", secondary: "#C0111F" },
  TOR: { primary: "#134A8E", secondary: "#1D2D5C", alt: "#E8291C" },
  WSH: { primary: "#AB0003", secondary: "#14225A" },
};
