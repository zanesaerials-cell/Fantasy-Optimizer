import { getEspnLeague, getEspnFreeAgents, extractEspnRosters } from "../../lib/espn";
import {
  getSleeperLeague,
  getSleeperRosters,
  getSleeperUsers,
  getSleeperPlayers,
  getSleeperTrending,
} from "../../lib/sleeper";

export default async function handler(req, res) {
  try {
    const {
      ESPN_S2,
      ESPN_SWID,
      ESPN_LEAGUE_ID,
      ESPN_SEASON,
      ESPN_TEAM_ID,
      SLEEPER_LEAGUE_ID,
      SLEEPER_USERNAME,
    } = process.env;

    const [espnReport, sleeperReport] = await Promise.all([
      buildEspnReport({ ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID, ESPN_SEASON, ESPN_TEAM_ID }),
      buildSleeperReport({ SLEEPER_LEAGUE_ID, SLEEPER_USERNAME }),
    ]);

    res.status(200).json({ espn: espnReport, sleeper: sleeperReport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function buildEspnReport({ ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID, ESPN_SEASON, ESPN_TEAM_ID }) {
  if (!ESPN_S2 || !ESPN_SWID || !ESPN_LEAGUE_ID) {
    return { configured: false, reason: "Missing ESPN_S2 / ESPN_SWID / ESPN_LEAGUE_ID env vars" };
  }
  const season = ESPN_SEASON || new Date().getFullYear();
  const league = await getEspnLeague({
    season,
    leagueId: ESPN_LEAGUE_ID,
    espnS2: ESPN_S2,
    swid: ESPN_SWID,
  });
  const rosters = extractEspnRosters(league);
  const myTeam = rosters.find((t) => String(t.teamId) === String(ESPN_TEAM_ID)) || null;

  let freeAgents = [];
  try {
    const faJson = await getEspnFreeAgents({
      season,
      leagueId: ESPN_LEAGUE_ID,
      espnS2: ESPN_S2,
      swid: ESPN_SWID,
    });
    freeAgents = (faJson.players || [])
      .map((entry) => ({
        name: entry.player?.fullName,
        position:
          { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" }[entry.player?.defaultPositionId] ||
          "FLEX",
        percentOwned: entry.player?.ownership?.percentOwned ?? 0,
      }))
      .sort((a, b) => b.percentOwned - a.percentOwned)
      .slice(0, 25);
  } catch (e) {
    // Non-fatal — free agent view can be flaky; report still useful without it.
  }

  const recommendations = myTeam ? buildLineupRecommendations(myTeam) : [];

  return {
    configured: true,
    myTeam,
    allTeams: rosters.map((t) => ({ teamId: t.teamId, teamName: t.teamName })),
    topFreeAgents: freeAgents,
    lineupRecommendations: recommendations,
  };
}

async function buildSleeperReport({ SLEEPER_LEAGUE_ID, SLEEPER_USERNAME }) {
  if (!SLEEPER_LEAGUE_ID) {
    return { configured: false, reason: "Missing SLEEPER_LEAGUE_ID env var" };
  }
  const [league, rosters, users, players, trendingAdds] = await Promise.all([
    getSleeperLeague(SLEEPER_LEAGUE_ID),
    getSleeperRosters(SLEEPER_LEAGUE_ID),
    getSleeperUsers(SLEEPER_LEAGUE_ID),
    getSleeperPlayers(),
    getSleeperTrending("add", 24, 40),
  ]);

  const userMap = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const myUser = SLEEPER_USERNAME
    ? users.find(
        (u) => u.display_name?.toLowerCase() === SLEEPER_USERNAME.toLowerCase() ||
               u.username?.toLowerCase() === SLEEPER_USERNAME.toLowerCase()
      )
    : null;
  const myRoster = myUser ? rosters.find((r) => r.owner_id === myUser.user_id) : null;

  const enrichRoster = (roster) => ({
    ownerName: userMap[roster.owner_id]?.display_name || "Unknown",
    starters: (roster.starters || []).map((id) => enrichPlayer(id, players)),
    bench: (roster.players || [])
      .filter((id) => !(roster.starters || []).includes(id))
      .map((id) => enrichPlayer(id, players)),
    record: `${roster.settings?.wins ?? 0}-${roster.settings?.losses ?? 0}`,
    pointsFor: roster.settings?.fpts ?? 0,
  });

  const myRosterEnriched = myRoster ? enrichRoster(myRoster) : null;

  // Trending adds filtered down to unrostered players in this league, as a waiver signal.
  const rosteredIds = new Set(rosters.flatMap((r) => r.players || []));
  const waiverSuggestions = trendingAdds
    .filter((t) => !rosteredIds.has(t.player_id))
    .map((t) => ({ ...enrichPlayer(t.player_id, players), addCount24h: t.count }))
    .slice(0, 15);

  return {
    configured: true,
    leagueName: league.name,
    myRoster: myRosterEnriched,
    allRosters: rosters.map((r) => ({
      ownerName: userMap[r.owner_id]?.display_name || "Unknown",
      record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}`,
    })),
    waiverSuggestions,
  };
}

function enrichPlayer(playerId, players) {
  if (playerId === "0" || !playerId) return { name: "Empty", position: "-" };
  const p = players[playerId];
  if (!p) return { name: playerId, position: "?" };
  return {
    playerId,
    name: p.full_name || `${p.first_name} ${p.last_name}`,
    position: p.position,
    team: p.team,
    injuryStatus: p.injury_status || "Active",
  };
}

// Simple heuristic: for each starting slot, check if a bench player at an
// eligible position has scored more points on average — flag a swap.
function buildLineupRecommendations(team) {
  const starters = team.players.filter(
    (p) => p.lineupSlot !== "BENCH" && p.lineupSlot !== "IR"
  );
  const bench = team.players.filter((p) => p.lineupSlot === "BENCH");

  const recs = [];
  for (const starter of starters) {
    const betterBenchOption = bench
      .filter((b) => b.position === starter.position && (b.avgPoints || 0) > (starter.avgPoints || 0))
      .sort((a, b) => (b.avgPoints || 0) - (a.avgPoints || 0))[0];
    if (betterBenchOption) {
      recs.push({
        type: "start_sit",
        message: `Consider starting ${betterBenchOption.name} (${betterBenchOption.avgPoints?.toFixed(1)} avg pts) over ${starter.name} (${(starter.avgPoints || 0).toFixed(1)} avg pts)`,
      });
    }
    if (starter.injuryStatus && starter.injuryStatus !== "ACTIVE") {
      recs.push({
        type: "injury_flag",
        message: `${starter.name} is listed as ${starter.injuryStatus} — check status before lock`,
      });
    }
  }
  return recs;
}
