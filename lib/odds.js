// Market-implied projections from sportsbook player props.
//
// WHY THIS EXISTS: neither ESPN nor Sleeper exposes a trustworthy public
// projection. Sportsbooks price player props (pass yards, receptions,
// anytime TD) with real money on the line, so those lines are usually a
// sharper estimate of a player's expected production than a free
// projection feed. We convert the lines into fantasy points using YOUR
// league's scoring settings.
//
// REQUIRES a key from https://the-odds-api.com. Player-prop markets are
// NOT on their free tier — the free 500-credit plan covers game lines
// only. Props need a paid plan, and each event costs credits per market,
// so this endpoint is called on demand (when you open the Projections
// tab), never on every page load.
//
// Without ODDS_API_KEY set, the app runs fine and just hides this tab.

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const SPORT = "americanfootball_nfl";

const MARKETS = [
  "player_pass_yds",
  "player_pass_tds",
  "player_pass_interceptions",
  "player_rush_yds",
  "player_rush_tds",
  "player_reception_yds",
  "player_receptions",
  "player_anytime_td",
];

export function oddsConfigured() {
  return Boolean(process.env.ODDS_API_KEY);
}

async function oddsGet(path, params = {}) {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  const qs = new URLSearchParams({ apiKey: key, ...params });
  const res = await fetch(`${ODDS_BASE}${path}?${qs}`);
  if (res.status === 401) throw new Error("The Odds API rejected the key (401).");
  if (res.status === 422)
    throw new Error("Player-prop markets aren't available on this Odds API plan.");
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return {
    data: await res.json(),
    creditsRemaining: res.headers.get("x-requests-remaining"),
    creditsUsed: res.headers.get("x-requests-used"),
  };
}

/** American odds -> implied probability, with vig left in (close enough). */
export function impliedProbability(american) {
  if (american == null) return null;
  return american < 0
    ? -american / (-american + 100)
    : 100 / (american + 100);
}

/** Upcoming NFL events in the next `days` days. */
export async function getEvents(days = 8) {
  const { data } = await oddsGet(`/sports/${SPORT}/events`, {
    daysFrom: String(days),
  });
  return data;
}

/** Props for one event, flattened to { playerName: { market: line/price } }. */
export async function getEventProps(eventId) {
  const { data, creditsRemaining } = await oddsGet(
    `/sports/${SPORT}/events/${eventId}/odds`,
    {
      regions: "us",
      markets: MARKETS.join(","),
      oddsFormat: "american",
    }
  );

  const byPlayer = {};
  for (const book of data.bookmakers || []) {
    for (const market of book.markets || []) {
      for (const outcome of market.outcomes || []) {
        const player = outcome.description;
        if (!player) continue;
        byPlayer[player] = byPlayer[player] || {};
        const slot = (byPlayer[player][market.key] =
          byPlayer[player][market.key] || { lines: [], prices: [] });
        // "Over" side carries the line we care about for yardage/receptions.
        if (outcome.point != null && outcome.name?.toLowerCase() === "over") {
          slot.lines.push(outcome.point);
        }
        if (market.key === "player_anytime_td" && outcome.name?.toLowerCase() === "yes") {
          slot.prices.push(outcome.price);
        }
      }
    }
  }

  // Consensus = median across books, which resists one book's outlier.
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const consensus = {};
  for (const [player, markets] of Object.entries(byPlayer)) {
    consensus[player] = {};
    for (const [key, v] of Object.entries(markets)) {
      consensus[player][key] = {
        line: median(v.lines),
        tdProb: v.prices.length ? impliedProbability(median(v.prices)) : null,
      };
    }
  }
  return { consensus, creditsRemaining, homeTeam: data.home_team, awayTeam: data.away_team };
}

/**
 * Turn consensus prop lines into expected fantasy points using the
 * league's own scoring rules.
 *
 * `scoring` shape: { passYd, passTd, passInt, rushYd, rushTd, recYd, rec, recTd }
 * as points-per-unit (e.g. passYd 0.04 = 1pt per 25 yards).
 */
export function propsToFantasyPoints(playerProps, scoring) {
  if (!playerProps) return null;
  const g = (k) => playerProps[k]?.line ?? null;
  let pts = 0;
  let used = [];

  const passYd = g("player_pass_yds");
  if (passYd != null) { pts += passYd * scoring.passYd; used.push(`${passYd} pass yds`); }

  const passTd = g("player_pass_tds");
  if (passTd != null) { pts += passTd * scoring.passTd; used.push(`${passTd} pass TD`); }

  const ints = g("player_pass_interceptions");
  if (ints != null) pts += ints * scoring.passInt;

  const rushYd = g("player_rush_yds");
  if (rushYd != null) { pts += rushYd * scoring.rushYd; used.push(`${rushYd} rush yds`); }

  const recYd = g("player_reception_yds");
  if (recYd != null) { pts += recYd * scoring.recYd; used.push(`${recYd} rec yds`); }

  const recs = g("player_receptions");
  if (recs != null) { pts += recs * scoring.rec; used.push(`${recs} rec`); }

  // Anytime-TD probability stands in for expected TDs. It slightly
  // understates players who score multiples, so nudge it up ~12%.
  const tdProb = playerProps["player_anytime_td"]?.tdProb;
  if (tdProb != null) {
    const expectedTds = tdProb * 1.12;
    pts += expectedTds * scoring.rushTd;
    used.push(`${(tdProb * 100).toFixed(0)}% TD`);
  }

  if (!used.length) return null;
  return {
    points: Number(pts.toFixed(1)),
    tdProbability: tdProb != null ? Number((tdProb * 100).toFixed(0)) : null,
    basis: used.join(" · "),
  };
}

/** Pull ESPN/Sleeper scoring settings into the shape above. */
export function scoringFromSleeper(league) {
  const s = league?.scoring_settings || {};
  return {
    passYd: s.pass_yd ?? 0.04,
    passTd: s.pass_td ?? 4,
    passInt: s.pass_int ?? -2,
    rushYd: s.rush_yd ?? 0.1,
    rushTd: s.rush_td ?? 6,
    recYd: s.rec_yd ?? 0.1,
    rec: s.rec ?? 0,
    recTd: s.rec_td ?? 6,
  };
}

/** ESPN scoring items are keyed by statId. */
export function scoringFromEspn(settings) {
  const items = settings?.scoringSettings?.scoringItems || [];
  const byId = Object.fromEntries(items.map((i) => [i.statId, i.points]));
  return {
    passYd: byId[3] ?? 0.04,
    passTd: byId[4] ?? 4,
    passInt: byId[20] ?? -2,
    rushYd: byId[24] ?? 0.1,
    rushTd: byId[25] ?? 6,
    recYd: byId[42] ?? 0.1,
    rec: byId[53] ?? 0,
    recTd: byId[43] ?? 6,
  };
}

/** Loose name matching — books write "A.J. Brown", Sleeper writes "AJ Brown". */
export function normalizeName(n = "") {
  return n
    .toLowerCase()
    .replace(/[.'\-,]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildPropIndex(consensus) {
  const idx = {};
  for (const [name, markets] of Object.entries(consensus || {})) {
    idx[normalizeName(name)] = markets;
  }
  return idx;
}
