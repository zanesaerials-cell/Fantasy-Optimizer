/**
 * Centralized synchronization.
 *
 * One function produces the complete normalized dataset for a league. Every
 * API route and every UI component reads from this, so the same underlying
 * ESPN/Sleeper data is never fetched twice for one request.
 */

import { EspnAdapter } from "./adapters/espn.js";
import { SleeperAdapter } from "./adapters/sleeper.js";
import { findLeagueConfig, loadLeagueConfigs } from "./config.js";
import { projectRoster } from "./projections.js";
import { analyzeLineup } from "./optimizer.js";
import {
  rankWaiverTargets, rosterHealth, scoutOpponent, benchPointsHistory, powerRankings,
} from "./analysis/index.js";
import * as recs from "./recommendations.js";
import { log, timed } from "./logger.js";
import { cached, TTL } from "./cache.js";

export function adapterFor(config) {
  if (config.platform === "espn") return new EspnAdapter(config);
  if (config.platform === "sleeper") return new SleeperAdapter(config);
  throw new Error(`Unknown platform: ${config.platform}`);
}

/** Group each player's prior weekly actuals by canonical id. */
function historyIndex(weeklyHistory) {
  const idx = {};
  for (const wk of weeklyHistory) {
    for (const p of wk.players || []) {
      if (p.weekActual == null) continue;
      (idx[p.canonicalId] = idx[p.canonicalId] || []).push(p.weekActual);
    }
  }
  return idx;
}

/**
 * Full sync for one league.
 *
 * @param opts.deep  include prior-week history (needed for bench points,
 *                   volatility, floor/ceiling). Costs N extra requests, so
 *                   the dashboard skips it and league detail pages use it.
 */
export async function syncLeague(config, opts = {}) {
  const { preference = "balanced", deep = false, marketByName = {} } = opts;
  const adapter = adapterFor(config);
  const startedAt = Date.now();

  const week = opts.week || (await adapter.getCurrentWeek());
  const [league, teams] = await Promise.all([
    adapter.getLeague(week),
    adapter.getTeams(week),
  ]);

  // Which team is mine?
  let myTeamId = config.platformTeamId;
  if (!myTeamId && config.platform === "sleeper") {
    myTeamId = await adapter.resolveMyTeamId();
  }

  const myTeamRaw = teams.find((t) => t.platformTeamId === String(myTeamId));

  if (!myTeamRaw) {
    return {
      ok: false,
      needsIdentity: true,
      league,
      week,
      syncedAt: new Date().toISOString(),
      error:
        config.platform === "espn"
          ? "Set the team ID for this league so we know which team is yours."
          : "Set the Sleeper username for this league so we know which team is yours.",
      choices: teams.map((t) => ({ id: t.platformTeamId, name: t.teamName })),
    };
  }

  // Prior-week history powers volatility, floor/ceiling and bench points.
  let history = [];
  if (deep && week > 1) {
    history = await adapter
      .getWeeklyHistory(myTeamRaw.platformTeamId, week - 1)
      .catch((e) => {
        log.warn("history fetch failed", { league: config.id, error: e.message });
        return [];
      });
  }
  const histIdx = historyIndex(history);

  // Attach projections to every roster in the league.
  const projectedTeams = teams.map((t) => ({
    ...t,
    roster: projectRoster(t.roster || [], histIdx, marketByName),
  }));

  const myTeam = projectedTeams.find((t) => t.platformTeamId === String(myTeamId));
  const slots = league.rosterSlots || [];

  const lineup = analyzeLineup(myTeam.roster, slots, preference);
  const matchup = await adapter.getMatchup(myTeam.platformTeamId, week).catch(() => null);
  const oppTeam = matchup?.oppTeamId
    ? projectedTeams.find((t) => t.platformTeamId === String(matchup.oppTeamId))
    : null;

  const waiverResult = await adapter.getWaivers(week).catch(() => ({ supported: false, data: null }));
  const waiverCandidates = waiverResult.supported
    ? projectRoster(waiverResult.data, histIdx, marketByName)
    : [];
  const waivers = waiverResult.supported
    ? rankWaiverTargets({ candidates: waiverCandidates, myRoster: myTeam.roster, slots, preference })
    : [];

  const scouting = oppTeam ? scoutOpponent({ myTeam, oppTeam, slots, preference }) : null;
  const health = rosterHealth({ myRoster: myTeam.roster, allTeams: projectedTeams, slots, preference });
  const bench = deep && history.length ? benchPointsHistory({ weeklyHistory: history, slots }) : null;

  const recommendations = recs.sortByUrgency([
    ...recs.fromLineup({ league, team: myTeam, analysis: lineup }),
    ...recs.fromWaivers({ league, team: myTeam, targets: waivers }),
    ...recs.fromMatchup({
      league, team: myTeam, matchup,
      myProjected: scouting?.myProjected ?? lineup.current.projectedPoints,
      oppProjected: scouting?.oppProjected ?? null,
    }),
  ]);

  return {
    ok: true,
    league,
    week,
    myTeam,
    teams: projectedTeams,
    oppTeam,
    matchup,
    lineup,
    waivers,
    waiverSupported: waiverResult.supported,
    waiverUnsupportedReason: waiverResult.supported ? null : waiverResult.reason,
    scouting,
    health,
    benchPoints: bench,
    powerRankings: powerRankings({ teams: projectedTeams, slots, preference }),
    recommendations,
    summary: recs.summarize(recommendations),
    syncedAt: new Date().toISOString(),
    syncMs: Date.now() - startedAt,
  };
}

/**
 * Sync every configured league in parallel. A failure in one league never
 * takes down the dashboard — it comes back as an error entry alongside the
 * leagues that did work.
 */
export async function syncAllLeagues(opts = {}) {
  const { leagues, errors } = loadLeagueConfigs();

  const results = await Promise.all(
    leagues.map((config) =>
      timed(`sync:${config.id}`, () => syncLeague(config, opts)).catch((e) => ({
        ok: false,
        league: {
          id: config.id,
          name: config.label || `${config.platform} ${config.platformLeagueId}`,
          platform: config.platform,
        },
        error: e.message,
        causes: e.causes || [],
        status: e.status ?? null,
        syncedAt: new Date().toISOString(),
      }))
    )
  );

  return { leagues: results, configErrors: errors };
}

export { findLeagueConfig, loadLeagueConfigs, cached, TTL };
