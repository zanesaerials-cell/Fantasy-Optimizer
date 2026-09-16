import {
  oddsConfigured,
  getEvents,
  getEventProps,
  buildPropIndex,
  propsToFantasyPoints,
  normalizeName,
} from "../../lib/odds.js";

// Cached in module scope — props move slowly during the week and every
// Odds API call costs credits, so don't refetch on every page view.
let cache = { at: 0, index: null, credits: null };
const TTL = 1000 * 60 * 30; // 30 minutes

export default async function handler(req, res) {
  if (!oddsConfigured()) {
    return res.status(200).json({
      configured: false,
      error: "Set ODDS_API_KEY to enable market-based projections.",
    });
  }

  try {
    const names = (req.query.players || "").split("|").filter(Boolean);
    const scoring = req.query.scoring ? JSON.parse(req.query.scoring) : null;

    if (!cache.index || Date.now() - cache.at > TTL) {
      const events = await getEvents(8);
      const slice = events.slice(0, 16); // whole slate, bounded
      const results = await Promise.all(
        slice.map((e) => getEventProps(e.id).catch(() => null))
      );
      const merged = {};
      let credits = null;
      for (const r of results) {
        if (!r) continue;
        Object.assign(merged, r.consensus);
        credits = r.creditsRemaining ?? credits;
      }
      cache = { at: Date.now(), index: buildPropIndex(merged), credits };
    }

    const out = {};
    if (names.length && scoring) {
      for (const n of names) {
        const props = cache.index[normalizeName(n)];
        const fp = props ? propsToFantasyPoints(props, scoring) : null;
        if (fp) out[n] = fp;
      }
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    res.status(200).json({
      configured: true,
      playersPriced: Object.keys(cache.index || {}).length,
      creditsRemaining: cache.credits,
      projections: out,
      cachedAt: new Date(cache.at).toISOString(),
    });
  } catch (err) {
    res.status(200).json({ configured: true, error: err.message, projections: {} });
  }
}
