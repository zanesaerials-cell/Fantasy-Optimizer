// Sleeper API — fully public, no auth required.

const BASE = "https://api.sleeper.app/v1";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper ${res.status} on ${path}`);
  return res.json();
}

export const getLeague = (id) => get(`/league/${id}`);
export const getRosters = (id) => get(`/league/${id}/rosters`);
export const getUsers = (id) => get(`/league/${id}/users`);

/* The old version never called this — which is why no Sleeper points
 * showed up anywhere. /rosters returns player IDs only. Actual scoring
 * lives here, as players_points (every rostered player) and
 * starters_points (starters, in lineup order). */
export const getMatchups = (id, week) => get(`/league/${id}/matchups/${week}`);

export const getNflState = () => get(`/state/nfl`);
export const getTransactions = (id, week) => get(`/league/${id}/transactions/${week}`);
export const getTrending = (type = "add", hours = 24, limit = 50) =>
  get(`/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`);

/* The player dictionary is ~5MB and changes maybe once a day. Cache it in
 * module scope so a warm serverless instance reuses it. */
let playerCache = null;
let playerCacheAt = 0;
const TTL = 1000 * 60 * 60 * 6;

export async function getPlayers() {
  if (playerCache && Date.now() - playerCacheAt < TTL) return playerCache;
  playerCache = await get(`/players/nfl`);
  playerCacheAt = Date.now();
  return playerCache;
}

/** Points-per-reception from the league's own scoring settings. */
export function pprValue(league) {
  return league?.scoring_settings?.rec ?? 0;
}

/** Roster slot labels, e.g. ["QB","RB","RB","WR","WR","FLEX",...] */
export function rosterSlots(league) {
  return (league?.roster_positions || []).filter((p) => p !== "BN" && p !== "IR");
}

export function enrich(playerId, players, pointsMap = {}) {
  if (!playerId || playerId === "0") return { name: "Empty slot", position: "-" };
  const p = players[playerId];
  const pts = pointsMap[playerId];
  if (!p) {
    return { playerId, name: String(playerId), position: "?", weekActual: pts ?? null };
  }
  // Team defenses come back as the team abbreviation, not a person.
  const name =
    p.position === "DEF"
      ? `${p.team || playerId} Defense`
      : p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
  return {
    playerId,
    name,
    position: p.position,
    proTeam: p.team || "FA",
    injuryStatus: p.injury_status || null,
    number: p.number,
    age: p.age,
    yearsExp: p.years_exp,
    weekActual: pts ?? null,
    searchRank: p.search_rank ?? null,
  };
}

/** Season totals per player, summed across every week played so far. */
export async function seasonTotalsByPlayer(leagueId, throughWeek) {
  const weeks = Array.from({ length: Math.max(0, throughWeek) }, (_, i) => i + 1);
  const results = await Promise.all(
    weeks.map((w) => getMatchups(leagueId, w).catch(() => []))
  );
  const totals = {};
  const games = {};
  for (const week of results) {
    for (const entry of week || []) {
      for (const [pid, pts] of Object.entries(entry.players_points || {})) {
        if (pts == null) continue;
        totals[pid] = (totals[pid] || 0) + pts;
        games[pid] = (games[pid] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const pid of Object.keys(totals)) {
    out[pid] = {
      total: Number(totals[pid].toFixed(2)),
      avg: Number((totals[pid] / Math.max(1, games[pid])).toFixed(2)),
      games: games[pid],
    };
  }
  return out;
}
