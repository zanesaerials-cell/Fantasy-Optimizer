import { cacheStats, redisConfigured } from "../../lib/cache.js";
import { loadLeagueConfigs } from "../../lib/config.js";
import { oddsConfigured } from "../../lib/odds.js";

/** Lightweight health check. Reports status only — never secret values. */
export default async function handler(req, res) {
  const { leagues, errors } = loadLeagueConfigs();
  const started = Date.now();

  const ping = async (name, url, headers) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      return { name, status: r.ok ? "OK" : `HTTP ${r.status}`, ms: Date.now() - t };
    } catch (e) {
      return { name, status: "UNREACHABLE", ms: Date.now() - t, detail: e.message };
    }
  };

  const checks = [await ping("sleeper", "https://api.sleeper.app/v1/state/nfl")];

  const espnLeague = leagues.find((l) => l.platform === "espn");
  if (espnLeague && process.env.ESPN_S2) {
    const { normalizeCookies } = await import("../../lib/adapters/espn.js");
    const { s2, id } = normalizeCookies(process.env.ESPN_S2, process.env.ESPN_SWID);
    checks.push(
      await ping(
        "espn",
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${espnLeague.season}/segments/0/leagues/${espnLeague.platformLeagueId}?view=mTeam`,
        { Cookie: `espn_s2=${s2}; SWID=${id}`, Accept: "application/json" }
      )
    );
  } else {
    checks.push({ name: "espn", status: "NOT_CONFIGURED" });
  }

  const degraded = checks.some((c) => c.status !== "OK" && c.status !== "NOT_CONFIGURED");

  res.status(degraded ? 503 : 200).json({
    status: degraded ? "DEGRADED" : "OK",
    checks,
    projectionSource: oddsConfigured() ? "market + platform" : "platform + season average",
    cache: { ...cacheStats(), persistent: redisConfigured() ? "redis" : "in-memory only" },
    leaguesConfigured: leagues.length,
    configErrors: errors,
    ms: Date.now() - started,
  });
}
