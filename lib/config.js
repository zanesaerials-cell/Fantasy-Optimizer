/**
 * Multi-league configuration.
 *
 * v2 supported exactly one ESPN league and one Sleeper league via flat env
 * vars. Rather than break those, we still read them — they become the
 * "default" leagues — and add a LEAGUES variable for everything else.
 *
 * LEAGUES is a JSON array, set as a single-line Vercel env var:
 *
 *   [
 *     {"platform":"espn","leagueId":"2139594506","teamId":"3","name":"TexArkana"},
 *     {"platform":"espn","leagueId":"887766","teamId":"7","name":"Work League"},
 *     {"platform":"sleeper","leagueId":"1389719356375580672","username":"zane"}
 *   ]
 *
 * ESPN cookies are per-user, not per-league, so one ESPN_S2/ESPN_SWID pair
 * covers every ESPN league you're in.
 */

const ALLOWED_PLATFORMS = ["espn", "sleeper"];

/** Platform league IDs are numeric strings on both platforms. */
function validId(v) {
  return typeof v === "string" && /^[0-9]{4,25}$/.test(v);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function loadLeagueConfigs(env = process.env) {
  const out = [];
  const errors = [];

  // Legacy single-league vars.
  if (env.ESPN_LEAGUE_ID) {
    out.push({
      platform: "espn",
      platformLeagueId: String(env.ESPN_LEAGUE_ID).trim(),
      platformTeamId: env.ESPN_TEAM_ID ? String(env.ESPN_TEAM_ID).trim() : null,
      season: Number(env.ESPN_SEASON) || new Date().getFullYear(),
      label: null,
      source: "env",
    });
  }
  if (env.SLEEPER_LEAGUE_ID) {
    out.push({
      platform: "sleeper",
      platformLeagueId: String(env.SLEEPER_LEAGUE_ID).trim(),
      username: env.SLEEPER_USERNAME ? String(env.SLEEPER_USERNAME).trim() : null,
      season: Number(env.ESPN_SEASON) || new Date().getFullYear(),
      label: null,
      source: "env",
    });
  }

  // Additional leagues from the LEAGUES JSON blob.
  if (env.LEAGUES) {
    let parsed;
    try {
      parsed = JSON.parse(env.LEAGUES);
    } catch (e) {
      errors.push("LEAGUES is not valid JSON. It must be a single-line JSON array.");
      parsed = null;
    }
    if (parsed && !Array.isArray(parsed)) {
      errors.push("LEAGUES must be a JSON array.");
    } else if (parsed) {
      parsed.forEach((entry, i) => {
        const where = `LEAGUES[${i}]`;
        if (!ALLOWED_PLATFORMS.includes(entry.platform)) {
          errors.push(`${where}: platform must be "espn" or "sleeper".`);
          return;
        }
        const id = String(entry.leagueId ?? entry.platformLeagueId ?? "").trim();
        if (!validId(id)) {
          errors.push(`${where}: leagueId "${id}" is not a valid numeric league ID.`);
          return;
        }
        if (out.some((l) => l.platform === entry.platform && l.platformLeagueId === id)) {
          return; // already added via legacy vars
        }
        out.push({
          platform: entry.platform,
          platformLeagueId: id,
          platformTeamId: entry.teamId != null ? String(entry.teamId).trim() : null,
          username: entry.username ? String(entry.username).trim() : null,
          season: Number(entry.season) || Number(env.ESPN_SEASON) || new Date().getFullYear(),
          label: entry.name || null,
          source: "LEAGUES",
        });
      });
    }
  }

  // Stable internal ID, used in URLs. Never exposes cookies or secrets.
  for (const l of out) {
    l.id = `${l.platform}-${l.platformLeagueId}`;
  }

  return { leagues: out, errors };
}

/**
 * Look up a league config by internal id. Used to validate anything the
 * browser sends us — we never fetch a league the server wasn't configured
 * for, which keeps this from becoming an open ESPN/Sleeper proxy (SSRF).
 */
export function findLeagueConfig(id, env = process.env) {
  const { leagues } = loadLeagueConfigs(env);
  return leagues.find((l) => l.id === id) || null;
}

export { validId, slug };
