// ESPN fantasy football API (undocumented v3 "lm-api-reads" host).
// Auth = espn_s2 + SWID cookies from a logged-in league member.

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

function cookieHeaders(espnS2, swid, extra = {}) {
  return {
    Cookie: `espn_s2=${encodeURIComponent(espnS2)}; SWID=${swid}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

async function espnGet(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401)
      throw new Error("ESPN rejected the login cookies (401). Refresh ESPN_S2 / ESPN_SWID.");
    throw new Error(`ESPN ${res.status}: ${body.slice(0, 180)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ *
 * STAT PARSING — this is what was broken before.
 *
 * Every ESPN player carries an array of stat entries. They are NOT
 * ordered, and they mix together several different things:
 *
 *   statSourceId  0 = actual     1 = ESPN projection
 *   statSplitTypeId 0 = season total   1 = single scoring period
 *   scoringPeriodId 0 = whole season   N = week N
 *
 * The old code did stats.find(s => s.statSourceId === 0), which grabbed
 * whichever entry happened to be first — often an unplayed future week,
 * which is why some players read as blank or wrong. Always match on all
 * three fields.
 * ------------------------------------------------------------------ */

function pickStat(player, { sourceId = 0, week = 0, splitType = null }) {
  const entries = player?.stats || [];
  const wantSplit = splitType !== null ? splitType : week === 0 ? 0 : 1;

  // Strict match first.
  let hit = entries.find(
    (s) =>
      s.statSourceId === sourceId &&
      s.scoringPeriodId === week &&
      s.statSplitTypeId === wantSplit
  );
  // Some seasons omit statSplitTypeId — fall back to source + period only.
  if (!hit) {
    hit = entries.find(
      (s) => s.statSourceId === sourceId && s.scoringPeriodId === week
    );
  }
  return hit || null;
}

export function playerWeekActual(player, week) {
  const s = pickStat(player, { sourceId: 0, week });
  // appliedTotal can legitimately be 0 (a real zero-point game), so only
  // treat null/undefined as "no data".
  return s && s.appliedTotal != null ? s.appliedTotal : null;
}

export function playerWeekProjected(player, week) {
  const s = pickStat(player, { sourceId: 1, week });
  return s && s.appliedTotal != null ? s.appliedTotal : null;
}

export function playerSeason(player) {
  const s = pickStat(player, { sourceId: 0, week: 0, splitType: 0 });
  if (!s) return { total: null, avg: null };
  return {
    total: s.appliedTotal ?? null,
    // appliedAverage is per-game and already excludes byes/DNPs.
    avg: s.appliedAverage ?? null,
  };
}

const POSITION = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

const SLOT = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE",
  7: "OP", 16: "DEF", 17: "K", 18: "P", 19: "HC", 20: "BENCH", 21: "IR",
  23: "FLEX",
};

const PRO_TEAM = {
  0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
  7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
  14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
  20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
  26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL",
  34: "HOU",
};

export function normalizePlayer(p, week) {
  const season = playerSeason(p);
  return {
    playerId: p.id,
    name: p.fullName,
    position: POSITION[p.defaultPositionId] || "FLEX",
    proTeam: PRO_TEAM[p.proTeamId] ?? "",
    injuryStatus: p.injuryStatus || "ACTIVE",
    percentOwned: p.ownership?.percentOwned ?? null,
    percentStarted: p.ownership?.percentStarted ?? null,
    weekActual: playerWeekActual(p, week),
    weekProjected: playerWeekProjected(p, week),
    seasonTotal: season.total,
    seasonAvg: season.avg,
    eligibleSlots: (p.eligibleSlots || []).map((s) => SLOT[s]).filter(Boolean),
  };
}

/** League + rosters + matchups for a given week. */
export async function getEspnLeague({ season, leagueId, espnS2, swid, week }) {
  const views = [
    "mRoster", "mTeam", "mMatchup", "mSettings", "mStats", "mPositionalRatings",
  ].map((v) => `view=${v}`).join("&");
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&${views}`;
  return espnGet(url, cookieHeaders(espnS2, swid));
}

/** Free agents / waiver wire, with real projections attached. */
export async function getEspnFreeAgents({
  season, leagueId, espnS2, swid, week, limit = 200,
}) {
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      limit,
      offset: 0,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
      filterStatsForTopScoringPeriodIds: {
        value: 5,
        additionalValue: [`00${season}`, `10${season}`, `02${season}`, `01${week}${season}`],
      },
    },
  };
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?scoringPeriodId=${week}&view=kona_player_info`;
  return espnGet(url, cookieHeaders(espnS2, swid, {
    "x-fantasy-filter": JSON.stringify(filter),
  }));
}

export function extractTeams(leagueJson, week) {
  return (leagueJson.teams || []).map((t) => ({
    teamId: t.id,
    teamName:
      t.name || `${t.location || ""} ${t.nickname || ""}`.trim() || `Team ${t.id}`,
    abbrev: t.abbrev,
    logo: t.logo,
    record: `${t.record?.overall?.wins ?? 0}-${t.record?.overall?.losses ?? 0}`,
    pointsFor: t.record?.overall?.pointsFor ?? 0,
    players: (t.roster?.entries || []).map((e) => ({
      ...normalizePlayer(e.playerPoolEntry?.player || {}, week),
      lineupSlot: SLOT[e.lineupSlotId] ?? String(e.lineupSlotId),
      isStarter: e.lineupSlotId !== 20 && e.lineupSlotId !== 21,
    })),
  }));
}

export function extractMatchup(leagueJson, teamId, week) {
  const m = (leagueJson.schedule || []).find(
    (g) =>
      g.matchupPeriodId === week &&
      (g.home?.teamId === Number(teamId) || g.away?.teamId === Number(teamId))
  );
  if (!m) return null;
  const isHome = m.home?.teamId === Number(teamId);
  const me = isHome ? m.home : m.away;
  const opp = isHome ? m.away : m.home;
  const teams = leagueJson.teams || [];
  const nameOf = (id) => {
    const t = teams.find((x) => x.id === id);
    return t?.name || `${t?.location || ""} ${t?.nickname || ""}`.trim() || "Opponent";
  };
  return {
    myScore: me?.totalPoints ?? 0,
    oppScore: opp?.totalPoints ?? 0,
    oppTeamId: opp?.teamId,
    oppName: opp?.teamId ? nameOf(opp.teamId) : "Bye",
  };
}

export { POSITION, SLOT, PRO_TEAM };
