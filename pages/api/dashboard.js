import { syncAllLeagues } from "../../lib/sync.js";
import { sortByUrgency, summarize } from "../../lib/recommendations.js";
import { log } from "../../lib/logger.js";

const ALLOWED_PREFERENCES = ["conservative", "balanced", "upside"];

export default async function handler(req, res) {
  const preference = ALLOWED_PREFERENCES.includes(req.query.preference)
    ? req.query.preference
    : "balanced";

  try {
    const { leagues, configErrors } = await syncAllLeagues({ preference, deep: false });

    const ok = leagues.filter((l) => l.ok);
    const failed = leagues.filter((l) => !l.ok);

    const allRecs = sortByUrgency(ok.flatMap((l) => l.recommendations || []));

    res.setHeader("Cache-Control", "private, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      preference,
      configErrors,
      summary: {
        ...summarize(allRecs),
        leagueCount: leagues.length,
        healthyCount: ok.length,
        failedCount: failed.length,
      },
      recommendations: allRecs.slice(0, 40),
      leagues: leagues.map((l) =>
        l.ok
          ? {
              ok: true,
              id: l.league.id,
              name: l.league.name,
              platform: l.league.platform,
              week: l.week,
              teamName: l.myTeam.teamName,
              record: `${l.myTeam.record.wins}-${l.myTeam.record.losses}`,
              rank: l.myTeam.rank,
              pointsFor: l.myTeam.pointsFor,
              matchup: l.matchup
                ? {
                    oppName: l.matchup.oppName,
                    myScore: l.matchup.myScore,
                    oppScore: l.matchup.oppScore,
                    myProjected: l.scouting?.myProjected ?? l.lineup.current.projectedPoints,
                    oppProjected: l.scouting?.oppProjected ?? null,
                    winProbability: l.scouting?.winProbability ?? null,
                  }
                : null,
              lineupGain: l.lineup.gain,
              alerts: l.summary,
              syncedAt: l.syncedAt,
              syncMs: l.syncMs,
            }
          : {
              ok: false,
              id: l.league?.id,
              name: l.league?.name,
              platform: l.league?.platform,
              needsIdentity: l.needsIdentity || false,
              choices: l.choices || null,
              error: l.error,
              causes: l.causes || [],
            }
      ),
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error("dashboard failed", { error: err.message });
    res.status(500).json({ error: "Could not build the dashboard.", detail: err.message });
  }
}
