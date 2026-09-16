import { syncLeague } from "../../../lib/sync.js";
import { findLeagueConfig } from "../../../lib/config.js";
import { findTrades } from "../../../lib/analysis/index.js";
import { log } from "../../../lib/logger.js";

const ALLOWED_PREFERENCES = ["conservative", "balanced", "upside"];

export default async function handler(req, res) {
  const { id } = req.query;

  // Never fetch a league the server wasn't configured for. Without this
  // check the route would be an open ESPN/Sleeper proxy that anyone could
  // point at any league using our cookies.
  const config = findLeagueConfig(String(id));
  if (!config) {
    return res.status(404).json({ error: "That league isn't configured on this deployment." });
  }

  const preference = ALLOWED_PREFERENCES.includes(req.query.preference)
    ? req.query.preference
    : "balanced";

  try {
    const result = await syncLeague(config, { preference, deep: true });

    if (!result.ok) {
      return res.status(200).json(result);
    }

    const trades = findTrades({
      myTeam: result.myTeam,
      allTeams: result.teams,
      slots: result.league.rosterSlots,
      preference,
    });

    res.setHeader("Cache-Control", "private, s-maxage=120, stale-while-revalidate=600");
    res.status(200).json({ ...result, trades });
  } catch (err) {
    log.error("league sync failed", { league: String(id), error: err.message });
    res.status(200).json({
      ok: false,
      league: { id: config.id, platform: config.platform, name: config.label },
      error: err.message,
      causes: err.causes || [],
      status: err.status ?? null,
    });
  }
}
