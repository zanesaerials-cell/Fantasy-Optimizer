# Lineup — ESPN + Sleeper fantasy dashboard

Dark, mobile-first weekly dashboard for a private ESPN league and a Sleeper
league side by side: lineup optimizer, suggested moves, waiver targets,
standings.

## What changed in v2

**Two data bugs fixed.**

*ESPN stats were blank or wrong* (Trevor Lawrence showing nothing despite a
26.1-point week; JSN's numbers off). ESPN returns a stack of stat entries
per player — season totals, each individual week, and projections, all in
one unordered array. v1 did `stats.find(s => s.statSourceId === 0)`, which
grabbed whichever entry came first, often an unplayed future week. It also
never sent a `scoringPeriodId`, so ESPN defaulted to the current week. v2
matches on all three identifying fields (`statSourceId`, `statSplitTypeId`,
`scoringPeriodId`) and requests an explicit week. See `pickStat()` in
`lib/espn.js`.

*Sleeper showed no points at all.* The `/rosters` endpoint returns player
IDs only — no scoring. Points live on `/matchups/{week}` as a
`players_points` map, which v1 never called. v2 fetches it, and also sums
every prior week to build real season totals and averages.

**New:**
- Dark Sleeper-style UI, built mobile-first (44px tap targets, safe-area
  insets, sticky header, horizontal-scroll filter chips)
- Position filter (QB / RB / WR / TE / FLEX / K / DEF) on lineup and waivers
- Real lineup optimizer that reads your league's actual slot configuration
  and fills the most restrictive slots first, so FLEX gets genuine leftovers
- Waiver ranking by *upgrade over your weakest starter at that position*,
  not raw points — a WR3 who beats your WR5 matters more than a QB2 you'll
  never start
- Optional sportsbook player props as market-implied projections
- Standings tab, matchup scoreboard, injury flags

## Setup

Same env vars as before, plus one optional new one. In Vercel → Project
Settings → Environment Variables:

| Key | Value |
|---|---|
| `ESPN_S2` | your espn_s2 cookie |
| `ESPN_SWID` | your SWID cookie, braces included |
| `ESPN_LEAGUE_ID` | `2139594506` |
| `ESPN_SEASON` | `2026` |
| `ESPN_TEAM_ID` | your numeric team ID |
| `SLEEPER_LEAGUE_ID` | `1389719356375580672` |
| `SLEEPER_USERNAME` | your Sleeper display name |
| `ODDS_API_KEY` | *optional* — see below |

If `ESPN_TEAM_ID` or `SLEEPER_USERNAME` are missing or wrong, the app now
tells you and lists the valid values instead of silently showing nothing.

## About the betting odds

Neither ESPN nor Sleeper publishes a trustworthy free projection. Sportsbook
player props are priced with real money at stake, so they're usually a
sharper estimate of expected production. The app pulls consensus prop lines
(pass yards, rush yards, receptions, anytime TD) and converts them into
fantasy points **using your league's own scoring settings** — so a 0.5-PPR
league and a full-PPR league get different numbers from the same line.

Honest caveats:

- This needs a key from [the-odds-api.com](https://the-odds-api.com).
  Player-prop markets are **not on the free tier** — the free 500-credit
  plan covers game lines only. Props need a paid plan (~$30/mo at time of
  writing), and each event costs credits per market.
- Because of that, odds are fetched **lazily and cached 30 minutes**, not on
  every page load.
- Anytime-TD probability is used as a stand-in for expected touchdowns and
  is nudged up ~12% to account for multi-TD games. It's an approximation.
- Implied probabilities include the book's vig, so they sum slightly above
  100%. Fine for ranking players against each other; don't read them as
  true probabilities.
- Without the key, everything else works and the market numbers just don't
  appear. The app falls back to ESPN's projections, then season averages.

**This is a projection aid, not betting advice, and not "odds of winning."**
It reads the market's estimate of a player's production — it doesn't predict
your matchup.

## Adding to your phone home screen

Open the Vercel URL in Safari (iOS) or Chrome (Android) → Share → Add to
Home Screen. The theme-color and status-bar meta tags are already set so it
opens looking like a native app.

## Ideas worth building next

- **Write actions.** Right now everything is read-only, on purpose — it
  tells you what to do, you do it. Sleeper has no public write API; ESPN
  has an undocumented one that would let the app set lineups directly.
  Higher risk (bad request = wrong lineup), so consider a confirm step.
- **Bye-week and opponent-strength warnings.** Needs an NFL schedule
  source; both platforms expose it awkwardly.
- **Trade analyzer** comparing two rosters' projected points by position.
- **Push alerts** when a starter's status flips to Out — a Vercel cron job
  hitting `/api/report` and diffing against the last run.
- **Season-long history charts** per player, now that weekly data parses
  correctly.

## Local development

```bash
cp .env.local.example .env.local   # fill in values
npm install
npm run dev
```
