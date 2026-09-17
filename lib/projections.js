/**
 * Unified projection layer.
 *
 * Rule from the spec that matters most: never silently mix incomparable
 * numbers. Every projection carries its source, and the UI always shows
 * which one produced the number. We pick ONE source per player rather than
 * averaging a sportsbook line with a season average, because those two
 * things don't mean the same thing.
 *
 * Floor and ceiling are NOT invented. They're derived from the standard
 * deviation of that player's own actual weekly scores this season. With
 * fewer than 3 games played there isn't enough data, so we return null and
 * the UI shows nothing rather than a fabricated range.
 */

export const SOURCE = {
  MARKET: "market",
  PLATFORM: "platform",
  RECENT: "recent",
  SEASON: "season",
  NONE: "none",
};

export const SOURCE_LABEL = {
  market: "Market consensus",
  platform: "Platform projection",
  recent: "Recent 3-week average",
  season: "Season average",
  none: "No data",
};

/** Ranked best-to-worst. First one with a value wins. */
const HIERARCHY = [SOURCE.MARKET, SOURCE.PLATFORM, SOURCE.RECENT, SOURCE.SEASON];

function stdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * A locally-computed season average from raw weekly scores.
 *
 * With 2+ games, a straightforward mean is fine — one ambiguous zero gets
 * diluted by real data around it. With exactly one game, a NONZERO score
 * is unambiguous: there is no way to accrue fantasy points without having
 * actually played, so it's trusted as-is. A single ZERO is the genuinely
 * ambiguous case — it reads identically whether the player was active and
 * simply didn't score, or wasn't active at all — so it's treated as no
 * signal rather than a real average.
 */
function seasonAvgFromHistory(played) {
  if (played.length >= 2) return mean(played);
  if (played.length === 1) return played[0] !== 0 ? played[0] : null;
  return null;
}

/**
 * @param player     normalized roster player
 * @param history    array of that player's prior weekly actual scores
 * @param marketPts  market-implied points, or null
 */
export function project(player, history = [], marketPts = null) {
  const played = history.filter((v) => v != null);
  const recent = played.slice(-3);

  // Track which SEASON path fired: ESPN hands us its own season average
  // (already correctly excluding weeks the player didn't play), while for
  // Sleeper we compute it ourselves from raw weekly history.
  const platformSeasonAvg = player.seasonAvg ?? null;
  const computedSeasonAvg = seasonAvgFromHistory(played);

  const candidates = {
    [SOURCE.MARKET]: marketPts,
    [SOURCE.PLATFORM]: player.weekProjected ?? null,
    [SOURCE.RECENT]: recent.length >= 2 ? mean(recent) : null,
    [SOURCE.SEASON]: platformSeasonAvg ?? computedSeasonAvg,
  };

  let source = SOURCE.NONE;
  let points = null;
  for (const s of HIERARCHY) {
    if (candidates[s] != null && Number.isFinite(candidates[s])) {
      source = s;
      points = Number(candidates[s].toFixed(1));
      break;
    }
  }

  const sd = played.length >= 3 ? stdev(played) : null;
  const floor = sd != null && points != null
    ? Number(Math.max(0, points - sd).toFixed(1)) : null;
  const ceiling = sd != null && points != null
    ? Number((points + sd).toFixed(1)) : null;

  return {
    points,
    source,
    sourceLabel: labelFor(source, platformSeasonAvg != null, played.length, recent.length),
    floor,
    ceiling,
    volatility: sd != null ? Number(sd.toFixed(1)) : null,
    gamesPlayed: played.length,
    // A confidence score implies there's something to be confident about.
    // With zero sources there isn't one — say so instead of reporting a
    // manufactured "LOW 5%" that looks like a real measurement.
    confidence: points == null
      ? { score: null, level: "UNAVAILABLE", reasons: ["No projection data available"] }
      : confidenceFor({ candidates, played, sd, points }),
    at: new Date().toISOString(),
  };
}

function labelFor(source, isPlatformSeasonAvg, gamesPlayed, recentGames) {
  if (source === SOURCE.SEASON) {
    return isPlatformSeasonAvg
      ? SOURCE_LABEL.season
      : `Season average (${gamesPlayed} game${gamesPlayed === 1 ? "" : "s"})`;
  }
  if (source === SOURCE.RECENT) return `Recent form (${recentGames} games)`;
  return SOURCE_LABEL[source];
}

/**
 * Confidence is derived from data quality, not vibes:
 *   - how many independent sources produced a similar number
 *   - how much history exists
 *   - how volatile the player has been
 *   - whether their status is uncertain
 */
export function confidenceFor({ candidates, played, sd, points }) {
  const reasons = [];
  let score = 50;

  const present = Object.entries(candidates).filter(([, v]) => v != null && Number.isFinite(v));
  if (present.length >= 3) { score += 15; reasons.push("Three or more sources available"); }
  else if (present.length === 2) { score += 8; reasons.push("Two sources available"); }
  else if (present.length <= 1) { score -= 15; reasons.push("Only one source available"); }

  // Do independent sources agree?
  if (present.length >= 2 && points) {
    const vals = present.map(([, v]) => v);
    const spread = Math.max(...vals) - Math.min(...vals);
    const rel = spread / Math.max(1, points);
    if (rel < 0.15) { score += 20; reasons.push("Sources agree closely"); }
    else if (rel < 0.35) { score += 5; reasons.push("Sources broadly agree"); }
    else { score -= 15; reasons.push("Sources disagree substantially"); }
  }

  if (played.length >= 6) { score += 10; reasons.push(`${played.length} games of history`); }
  else if (played.length <= 2) { score -= 15; reasons.push("Little game history"); }

  if (sd != null && points) {
    const cv = sd / Math.max(1, points);
    if (cv > 0.6) { score -= 15; reasons.push("Highly volatile week to week"); }
    else if (cv < 0.3) { score += 10; reasons.push("Consistent week to week"); }
  }

  const clamped = Math.max(5, Math.min(95, Math.round(score)));
  return {
    score: clamped,
    level: clamped >= 70 ? "HIGH" : clamped >= 45 ? "MEDIUM" : "LOW",
    reasons,
  };
}

/**
 * Risk preference shifts which number we optimize against. It must never
 * change the underlying statistics — only which one we weight.
 */
export function preferenceValue(projection, preference = "balanced") {
  if (!projection || projection.points == null) return 0;
  const { points, floor, ceiling } = projection;
  if (preference === "conservative" && floor != null) return points * 0.6 + floor * 0.4;
  if (preference === "upside" && ceiling != null) return points * 0.6 + ceiling * 0.4;
  return points;
}

/** Attach projections to a roster in one pass. */
export function projectRoster(players, historyByCanonical = {}, marketByName = {}) {
  return players.map((p) => {
    const hist = historyByCanonical[p.canonicalId] || [];
    const market = marketByName[p.name]?.points ?? null;
    return { ...p, projection: project(p, hist, market) };
  });
}
