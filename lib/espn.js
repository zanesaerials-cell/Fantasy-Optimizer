// Talks to ESPN's undocumented fantasy football API server-side.
// Auth is via the espn_s2 + SWID cookies of a logged-in league member.

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

async function espnFetch(path, { season, leagueId, espnS2, swid, params = "" }) {
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}${path}${params}`;
  const res = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ESPN API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Pulls rosters, team info, and current matchups for the league.
export async function getEspnLeague({ season, leagueId, espnS2, swid }) {
  return espnFetch("", {
    season,
    leagueId,
    espnS2,
    swid,
    params: "?view=mRoster&view=mTeam&view=mMatchup&view=mSettings",
  });
}

// Pulls free agents / waiver wire, sorted by ESPN's own projected points.
export async function getEspnFreeAgents({ season, leagueId, espnS2, swid, limit = 60 }) {
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`;
  const res = await fetch(url, {
    headers: {
      Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
      "Content-Type": "application/json",
      "x-fantasy-filter": JSON.stringify({
        players: {
          filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
          limit,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
        },
      }),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ESPN API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Flattens ESPN's roster blob into { teamId, teamName, players: [...] }
export function extractEspnRosters(leagueJson) {
  const teams = leagueJson.teams || [];
  return teams.map((t) => ({
    teamId: t.id,
    teamName: `${t.location || ""} ${t.nickname || ""}`.trim() || t.name || `Team ${t.id}`,
    players: (t.roster?.entries || []).map((e) => {
      const p = e.playerPoolEntry?.player || {};
      const appliedTotal = p.stats?.find((s) => s.statSourceId === 0)?.appliedTotal ?? null;
      const avgPoints = p.stats?.find((s) => s.statSourceId === 0)?.appliedAverage ?? null;
      return {
        playerId: p.id,
        name: p.fullName,
        position: POSITION_MAP[p.defaultPositionId] || "FLEX",
        lineupSlot: SLOT_MAP[e.lineupSlotId] || e.lineupSlotId,
        proTeam: PRO_TEAM_MAP[p.proTeamId] || "",
        injuryStatus: p.injuryStatus || "ACTIVE",
        totalPoints: appliedTotal,
        avgPoints,
      };
    }),
  }));
}

const POSITION_MAP = {
  1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST",
};

const SLOT_MAP = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K",
  20: "BENCH", 21: "IR", 23: "FLEX",
};

const PRO_TEAM_MAP = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA",
  27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};
