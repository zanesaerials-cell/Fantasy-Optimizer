import { syncLeague } from "../../../lib/sync.js";
import { findLeagueConfig } from "../../../lib/config.js";
import { analyzeTrade } from "../../../lib/analysis/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const { leagueId, theirTeamId, giveIds, receiveIds, preference } = req.body || {};

  const config = findLeagueConfig(String(leagueId || ""));
  if (!config) {
    return res.status(404).json({ error: "That league isn't configured on this deployment." });
  }
  if (!Array.isArray(giveIds) || !Array.isArray(receiveIds)) {
    return res.status(400).json({ error: "giveIds and receiveIds must be arrays." });
  }
  if (giveIds.length > 6 || receiveIds.length > 6) {
    return res.status(400).json({ error: "Trades are limited to 6 players per side." });
  }

  const pref = ["conservative", "balanced", "upside"].includes(preference) ? preference : "balanced";

  try {
    const sync = await syncLeague(config, { preference: pref, deep: true });
    if (!sync.ok) return res.status(200).json(sync);

    const theirTeam = sync.teams.find((t) => t.id === theirTeamId || t.platformTeamId === String(theirTeamId));
    if (!theirTeam) {
      return res.status(400).json({
        error: "Unknown team.",
        choices: sync.teams.map((t) => ({ id: t.id, name: t.teamName })),
      });
    }

    const result = analyzeTrade({
      myTeam: sync.myTeam,
      theirTeam,
      giveIds: giveIds.map(String),
      receiveIds: receiveIds.map(String),
      slots: sync.league.rosterSlots,
      preference: pref,
    });

    res.status(200).json({
      ...result,
      simulation: true,
      note: "Simulation only — no changes were made to your roster.",
      myTeamName: sync.myTeam.teamName,
      theirTeamName: theirTeam.teamName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
