// Sleeper's API is fully public and needs no auth.

const BASE = "https://api.sleeper.app/v1";

async function sleeperFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${path}`);
  return res.json();
}

export async function getSleeperLeague(leagueId) {
  return sleeperFetch(`/league/${leagueId}`);
}

export async function getSleeperRosters(leagueId) {
  return sleeperFetch(`/league/${leagueId}/rosters`);
}

export async function getSleeperUsers(leagueId) {
  return sleeperFetch(`/league/${leagueId}/users`);
}

export async function getSleeperMatchups(leagueId, week) {
  return sleeperFetch(`/league/${leagueId}/matchups/${week}`);
}

// The full player dictionary is large (several MB) and rarely changes —
// cache it in memory per serverless instance rather than refetching per request.
let playerCache = null;
let playerCacheTime = 0;
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export async function getSleeperPlayers() {
  const now = Date.now();
  if (playerCache && now - playerCacheTime < CACHE_TTL_MS) return playerCache;
  playerCache = await sleeperFetch(`/players/nfl`);
  playerCacheTime = now;
  return playerCache;
}

// Trending adds/drops over the last N hours — used as a signal for
// waiver-wire suggestions since Sleeper's public API has no projections.
export async function getSleeperTrending(type = "add", hours = 24, limit = 50) {
  return sleeperFetch(`/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`);
}

export function getCurrentWeek(leagueSettings) {
  return leagueSettings?.leg || 1;
}
