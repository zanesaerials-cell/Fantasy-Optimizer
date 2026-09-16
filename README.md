# Fantasy Optimizer

A command center for managing multiple fantasy football teams across ESPN
and Sleeper. It tells you what needs attention, what to do about it, what
it's worth, and why — so you don't have to open six league pages.

Mobile-first, dark, deployed on Vercel.

---

## What v3 changed

v2 was a two-league dashboard. v3 is a multi-league decision tool built on
a platform-independent core.

**Architecture**
- Platform adapter layer (`lib/adapters/`). ESPN and Sleeper are normalized
  into one domain model before any product logic runs. Neither platform's
  quirks leak upward.
- Adapters return an explicit `unsupported` result rather than an empty
  array when a platform can't do something, so the UI can say "not
  available here" instead of looking broken.
- Centralized sync (`lib/sync.js`). One call produces the complete dataset
  for a league. No component fetches independently.
- Two-tier cache (`lib/cache.js`) with per-data-type TTLs. In-process by
  default; optionally backed by Upstash Redis with no added dependency.
- 53 automated tests, including regression tests pinning all four
  historical production bugs.

**Product**
- Command Center at `/` — every league, sorted by urgency
- Deterministic severity rules (CRITICAL / HIGH / MEDIUM / LOW)
- "Why?" on every recommendation, showing the actual inputs
- Lineup optimizer handling any slot configuration
- Bench points: what you scored vs. what the optimal lineup would have
- Opponent scouting with position-by-position edges
- Roster health scored against the league's own median
- Waiver ranking by upgrade over your weakest player at that position
- Trade analyzer and trade finder
- League switcher, bottom nav on mobile, three-column layout on desktop

---

## Configuration

### Existing leagues (unchanged from v2)

| Key | Value |
|---|---|
| `ESPN_S2` | your espn_s2 cookie |
| `ESPN_SWID` | your SWID cookie, braces included |
| `ESPN_LEAGUE_ID` | e.g. `2139594506` |
| `ESPN_SEASON` | e.g. `2026` |
| `ESPN_TEAM_ID` | your numeric team ID |
| `SLEEPER_LEAGUE_ID` | e.g. `1389719356375580672` |
| `SLEEPER_USERNAME` | your Sleeper display name |

Your existing setup keeps working — these become your default leagues.

### Adding more leagues

Set `LEAGUES` to a single-line JSON array:

```json
[{"platform":"espn","leagueId":"998877","teamId":"5","name":"Work League"},
 {"platform":"sleeper","leagueId":"112233445566778899","username":"zane"}]
```

One `ESPN_S2`/`ESPN_SWID` pair covers every ESPN league you're in — the
cookies are per-user, not per-league.

Malformed entries are reported on the dashboard rather than crashing the
app. League IDs are validated as numeric strings, and the API only ever
fetches leagues present in this config.

### Optional

| Key | Effect if unset |
|---|---|
| `ODDS_API_KEY` | Market projections disabled; falls back to platform projections, then season averages |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Cache is in-process only (still works, just colder between deploys) |

---

## How projections work

Every projection carries its source, and the UI always shows which one
produced the number. Sources are never averaged together, because a
sportsbook line and a season average don't mean the same thing.

Hierarchy, best first:

1. **Market consensus** — sportsbook player props converted to fantasy
   points using your league's scoring. Requires `ODDS_API_KEY`. Player-prop
   markets are not on The Odds API free tier.
2. **Platform projection** — ESPN's own weekly projection.
3. **Recent form** — the player's last three actual games.
4. **Season average**.

If none exist, the projection is `null` and the UI shows a dash. It never
guesses.

**Floor and ceiling** are the standard deviation of that player's *own*
actual weekly scores this season. Fewer than three games played means no
range is shown, rather than a fabricated one.

**Confidence** is derived from measurable data quality: how many sources
exist, whether they agree, how much history there is, and how volatile the
player has been. It is not an opinion.

**Win probability** is a Monte Carlo simulation over both rosters' weekly
variance. If either roster lacks enough history, it returns `null` rather
than an invented percentage.

---

## Risk preference

`?preference=conservative|balanced|upside` changes which number the
optimizer ranks by — floor-weighted, projection, or ceiling-weighted. It
never alters the underlying statistics, only the weighting.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/dashboard` | All leagues, all recommendations, sorted by urgency |
| `GET /api/leagues/:id` | One league in full (deep sync, includes history) |
| `POST /api/trades/analyze` | Simulate a trade. Never submits anything |
| `GET /api/health` | Platform reachability, cache stats, config status |
| `GET /api/diagnose` | ESPN auth troubleshooting |
| `GET /api/odds` | Market projections when configured |

---

## Security

- ESPN cookies are read server-side only. They are never sent to the
  browser, never placed in localStorage, never logged.
- `lib/logger.js` scrubs known secret values and secret-looking keys from
  every log line before serialization.
- `/api/diagnose` reports only lengths and pass/fail checks, never values.
- League IDs from the browser are validated against the server's configured
  leagues before any upstream request, so the API can't be used as an open
  ESPN/Sleeper proxy.
- Trade endpoints bound input size and validate array shapes.
- `.gitignore` covers `.env*` — **it was missing from the repo before v3**,
  which meant a local `.env.local` could have been committed.

---

## Testing

```bash
npm test     # 53 tests
```

Regression tests in `test/regressions.test.js` pin four bugs that shipped
to production. If one fails, a real user-visible bug has returned:

1. **ESPN cookie double-encoding** — `espn_s2` arrives already
   percent-encoded; encoding it again produced `%25` sequences and a 401
   indistinguishable from an expired session.
2. **ESPN stat selection** — `player.stats` is an unordered array mixing
   season totals, every week, and projections. Matching only on
   `statSourceId` returned whichever came first, often an unplayed future
   week, so real scores rendered blank.
3. **Sleeper matchup points** — `/rosters` carries no scoring at all;
   points live on `/matchups/{week}`.
4. **OUT starters inflating the current lineup** — found by smoke test
   during v3 development. A player who cannot play must contribute zero,
   or the "points available" figure is understated.

Unit tests cover the optimizer (including the FLEX-steals-the-only-RB
case), projection hierarchy and fallbacks, confidence derivation,
cross-platform player identity matching, waiver ranking, bench points,
trade math, and config validation.

---

## Known limitations

Stated plainly, because the app never fabricates data:

- **No target share, snap counts, or defense-vs-position rankings.** These
  need a paid data provider. Recommendations use projections, variance,
  injury status and roster context only.
- **No schedule-strength outlook** for waiver targets, for the same reason.
- **ESPN transactions are unavailable.** ESPN's endpoint is unreliable for
  private leagues, so the adapter reports it as unsupported rather than
  showing an empty list.
- **"What changed since last visit" is not implemented.** It needs durable
  snapshots; the Redis layer exists but the feature does not yet.
- **Recommendation accuracy tracking is not implemented.** Same reason. It
  requires storing recommendations and scoring them after the week
  resolves.
- **Player profiles, player comparison, settings UI, scenario mode,
  dynasty features and the AI assistant are not implemented.**
- **Win probability assumes independent, normally-distributed scores.**
  Real scores correlate (shared game environments) and are right-skewed,
  so treat it as a reasonable estimate rather than a precise number.
- **Player identity matching across platforms is name+position based.** Two
  players sharing a name and position at the same time would collide.

---

## Local development

```bash
cp .env.local.example .env.local   # fill in values
npm install
npm run dev
npm test
```

## Deployment

Push to GitHub; Vercel builds automatically. Environment variable changes
require a redeploy to take effect.

```bash
npm run build   # verify before pushing
```
