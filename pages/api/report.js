import * as espn from "../../lib/espn";
import * as sleeper from "../../lib/sleeper";
import {
  optimizeLineup,
  buildRecommendations,
  scoreWaiverTarget,
  playerValue,
} from "../../lib/analysis";
import { oddsConfigured, scoringFromSleeper, scoringFromEspn } from "../../lib/odds";

export default async function handler(req, res) {
  const week = req.query.week ? Number(req.query.week) : null;

  try {
    const nflState = await sleeper.getNflState().catch(() => null);
    const currentWeek = week || nflState?.week || 1;

    const [espnReport, sleeperReport] = await Promise.all([
      buildEspn(currentWeek).catch((e) => ({ configured: false, error: e.message })),
      buildSleeper(currentWeek).catch((e) => ({ configured: false, error: e.message })),
    ]);

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    res.status(200).json({
      week: currentWeek,
      season: nflState?.season ?? process.env.ESPN_SEASON,
      seasonType: nflState?.season_type,
      oddsAvailable: oddsConfigured(),
      espn: espnReport,
      sleeper: sleeperReport,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function buildEspn(week) {
  const {
    ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID, ESPN_SEASON, ESPN_TEAM_ID,
  } = process.env;

  if (!ESPN_S2 || !ESPN_SWID || !ESPN_LEAGUE_ID) {
    return { configured: false, error: "Add ESPN_S2, ESPN_SWID and ESPN_LEAGUE_ID in Vercel." };
  }
  const season = Number(ESPN_SEASON) || new Date().getFullYear();

  const league = await espn.getEspnLeague({
    season, leagueId: ESPN_LEAGUE_ID, espnS2: ESPN_S2, swid: ESPN_SWID, week,
  });

  const teams = espn.extractTeams(league, week);
  const myTeam = teams.find((t) => String(t.teamId) === String(ESPN_TEAM_ID));

  if (!myTeam) {
    return {
      configured: true,
      needsTeamId: true,
      leagueName: league.settings?.name,
      teams: teams.map((t) => ({ teamId: t.teamId, teamName: t.teamName })),
      error: "Set ESPN_TEAM_ID to one of the team IDs listed.",
    };
  }

  // Build slot list from the league's own lineup settings.
  const slotCounts = league.settings?.rosterSettings?.lineupSlotCounts || {};
  const slots = [];
  for (const [slotId, count] of Object.entries(slotCounts)) {
    const label = espn.SLOT[Number(slotId)];
    if (!label || label === "BENCH" || label === "IR") continue;
    for (let i = 0; i < count; i++) slots.push(label);
  }

  const currentStarters = myTeam.players.filter((p) => p.isStarter);
  const optimal = optimizeLineup(myTeam.players, slots);
  const recommendations = buildRecommendations({
    currentStarters,
    optimal,
    allPlayers: myTeam.players,
  });

  let freeAgents = [];
  try {
    const fa = await espn.getEspnFreeAgents({
      season, leagueId: ESPN_LEAGUE_ID, espnS2: ESPN_S2, swid: ESPN_SWID, week,
    });
    freeAgents = (fa.players || [])
      .map((e) => espn.normalizePlayer(e.player || {}, week))
      .filter((p) => p.name)
      .map((p) => ({ ...p, ...scoreWaiverTarget(p, myTeam.players) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 120);
  } catch (e) {
    freeAgents = [];
  }

  return {
    configured: true,
    leagueName: league.settings?.name || "ESPN League",
    week,
    scoring: scoringFromEspn(league.settings),
    myTeam: {
      ...myTeam,
      currentProjected: Number(
        currentStarters.reduce((s, p) => s + playerValue(p).value, 0).toFixed(1)
      ),
    },
    matchup: espn.extractMatchup(league, ESPN_TEAM_ID, week),
    slots,
    optimal,
    recommendations,
    freeAgents,
    standings: teams
      .map((t) => ({
        teamId: t.teamId, teamName: t.teamName, record: t.record, pointsFor: t.pointsFor,
      }))
      .sort((a, b) => b.pointsFor - a.pointsFor),
  };
}

async function buildSleeper(week) {
  const { SLEEPER_LEAGUE_ID, SLEEPER_USERNAME } = process.env;
  if (!SLEEPER_LEAGUE_ID) {
    return { configured: false, error: "Add SLEEPER_LEAGUE_ID in Vercel." };
  }

  const [league, rosters, users, players, matchups, trending] = await Promise.all([
    sleeper.getLeague(SLEEPER_LEAGUE_ID),
    sleeper.getRosters(SLEEPER_LEAGUE_ID),
    sleeper.getUsers(SLEEPER_LEAGUE_ID),
    sleeper.getPlayers(),
    sleeper.getMatchups(SLEEPER_LEAGUE_ID, week).catch(() => []),
    sleeper.getTrending("add", 24, 60).catch(() => []),
  ]);

  // Season-to-date totals, summed across every week played.
  const totals = await sleeper.seasonTotalsByPlayer(
    SLEEPER_LEAGUE_ID,
    Math.max(0, week - 1)
  ).catch(() => ({}));

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const matchupByRoster = Object.fromEntries(
    (matchups || []).map((m) => [m.roster_id, m])
  );

  const me = SLEEPER_USERNAME
    ? users.find(
        (u) =>
          u.display_name?.toLowerCase() === SLEEPER_USERNAME.toLowerCase() ||
          u.username?.toLowerCase() === SLEEPER_USERNAME.toLowerCase()
      )
    : null;
  const myRoster = me ? rosters.find((r) => r.owner_id === me.user_id) : null;

  if (!myRoster) {
    return {
      configured: true,
      needsUsername: true,
      leagueName: league.name,
      teams: users.map((u) => u.display_name),
      error: "Set SLEEPER_USERNAME to one of the names listed.",
    };
  }

  const mm = matchupByRoster[myRoster.roster_id] || {};
  const pointsMap = mm.players_points || {};

  const decorate = (pid) => {
    const base = sleeper.enrich(pid, players, pointsMap);
    const t = totals[pid];
    return {
      ...base,
      seasonTotal: t?.total ?? null,
      seasonAvg: t?.avg ?? null,
      gamesPlayed: t?.games ?? 0,
    };
  };

  const rosterPlayers = (myRoster.players || []).map(decorate);
  const starterIds = myRoster.starters || [];
  const currentStarters = starterIds.filter((id) => id && id !== "0").map(decorate);

  const slots = sleeper.rosterSlots(league);
  const optimal = optimizeLineup(rosterPlayers, slots);
  const recommendations = buildRecommendations({
    currentStarters, optimal, allPlayers: rosterPlayers,
  });

  // Opponent in this week's matchup.
  const oppEntry = (matchups || []).find(
    (m) => m.matchup_id === mm.matchup_id && m.roster_id !== myRoster.roster_id
  );
  const oppRoster = oppEntry ? rosters.find((r) => r.roster_id === oppEntry.roster_id) : null;

  const rosteredIds = new Set(rosters.flatMap((r) => r.players || []));
  const waiverTargets = (trending || [])
    .filter((t) => !rosteredIds.has(t.player_id))
    .map((t) => {
      const p = decorate(t.player_id);
      const scored = { ...p, addCount24h: t.count };
      return { ...scored, ...scoreWaiverTarget(scored, rosterPlayers) };
    })
    .filter((p) => p.position && p.position !== "?")
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);

  return {
    configured: true,
    leagueName: league.name,
    week,
    ppr: sleeper.pprValue(league),
    scoring: scoringFromSleeper(league),
    myTeam: {
      teamName: me.metadata?.team_name || me.display_name,
      owner: me.display_name,
      avatar: me.avatar,
      record: `${myRoster.settings?.wins ?? 0}-${myRoster.settings?.losses ?? 0}`,
      pointsFor: myRoster.settings?.fpts ?? 0,
      players: rosterPlayers,
      starters: currentStarters,
      weekScore: mm.points ?? null,
      currentProjected: Number(
        currentStarters.reduce((s, p) => s + playerValue(p).value, 0).toFixed(1)
      ),
    },
    matchup: oppEntry
      ? {
          myScore: mm.points ?? 0,
          oppScore: oppEntry.points ?? 0,
          oppName:
            userById[oppRoster?.owner_id]?.metadata?.team_name ||
            userById[oppRoster?.owner_id]?.display_name ||
            "Opponent",
        }
      : null,
    slots,
    optimal,
    recommendations,
    waiverTargets,
    standings: rosters
      .map((r) => ({
        teamName:
          userById[r.owner_id]?.metadata?.team_name ||
          userById[r.owner_id]?.display_name ||
          "Unknown",
        record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}`,
        pointsFor: r.settings?.fpts ?? 0,
      }))
      .sort((a, b) => b.pointsFor - a.pointsFor),
  };
}
