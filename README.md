# Fantasy Optimizer — ESPN + Sleeper Weekly Report

A small Next.js app that pulls your rosters from both a private ESPN league
and a Sleeper league, and shows lineup/waiver suggestions on one page.
Deployed on Vercel, refreshed on demand (just reload the page each week).

## What it actually does (read this first)

- **ESPN**: pulls your roster, applies a simple heuristic (bench player with
  higher season average than a starter at the same position → suggested
  swap), flags injury statuses, and lists top-owned free agents.
- **Sleeper**: pulls your roster/bench and cross-references Sleeper's
  "trending adds" (most-added players league-wide in the last 24h) against
  players unrostered in *your* league, as a waiver-wire signal.
- Neither platform's public API gives true "win probability" or vetted
  weekly projections, so this is directional, not a betting-odds tool. If
  you want real projections later, the cleanest upgrade is plugging in a
  projections API (e.g. FantasyPros) inside `lib/`.

## 1. Get your ESPN cookies (one-time, per season)

1. Log into fantasy.espn.com on a desktop browser, in your league.
2. Open DevTools (F12) → Application (Chrome) or Storage (Firefox) → Cookies → `https://fantasy.espn.com`.
3. Copy the values of:
   - `espn_s2` (long string) AEB7OhYUyJ%2FiwidamBj01ZlS2Ddzg%2FQ7QV%2BgS3kOdTpkP9OydULwAmSS8TCgXCzF5wwG1Ma27oQi7hS%2BDdLRTg5F9iz9%2BV4P4cL4Qr4uHugnUUrF3sLtM3GXH4mrCGCA%2BNcs7GqG%2F%2B8HknaO2h6%2BRrz3b5bfJ4s6uZYwpgh14UO4ITe4t2naTV9t1K6B6683wOI70w0jbLjBFAEn%2BrdcacKWYVlWjn0duR38yLADscoOBDtJYVAjyI%2FklPPM%2Bvn4E3Nvw5DHdqJyjDJ%2F0xVo1jVIfplQDFvKh6AVzc%2FUuRyuqhpO%2BUL8UDS4pKvPeh1J4IB1s0rYyuJs3ySu4A0VzEyx
   - `SWID` (looks like `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, keep the curly braces)
{AB3BB2B4-2038-424F-9DC8-B4D586A2AA0B}

4. Find your **ESPN_TEAM_ID**: go to your team page, look at the URL for `teamId=N`. 7

These cookies typically last most of a season but can expire if you log out
everywhere — if the app starts erroring, just repeat this step and update
the Vercel env var.

## 2. Find your Sleeper username

Just your normal Sleeper display name/username — no login needed, Sleeper's
API is public.

## 3. Deploy

```bash
# from inside this folder
git init
git add .
git commit -m "Initial commit"
gh repo create fantasy-optimizer --private --source=. --push
# or push manually to a GitHub repo you create in the UI
```

Then on [vercel.com](https://vercel.com):
1. "Add New Project" → import the GitHub repo.
2. Before deploying, add these Environment Variables (Project Settings → Environment Variables):

| Key | Value |
|---|---|
| `ESPN_S2` | your espn_s2 cookie value |
| `ESPN_SWID` | your SWID cookie value (with braces) |
| `ESPN_LEAGUE_ID` | `2139594506` |
| `ESPN_SEASON` | `2026` |
| `ESPN_TEAM_ID` | your team's numeric ID |
| `SLEEPER_LEAGUE_ID` | `1389719356375580672` |
| `SLEEPER_USERNAME` | your Sleeper display name |

3. Deploy. Visit the given `*.vercel.app` URL any time to see the current report — reload before setting your lineup each week.

## 4. Local dev (optional)

```bash
cp .env.local.example .env.local   # fill in the values
npm install
npm run dev
```

## Notes / next steps you might want

- The free-agent and trending-add endpoints are unofficial ESPN/Sleeper
  behavior and can change without notice — if a section stops showing data,
  that's the most likely cause.
- To get an actual "should I start X or Y" answer with real projections,
  swap in a stats provider in `lib/` and merge it into
  `buildLineupRecommendations` in `pages/api/report.js`.
- Nothing here writes lineups or makes waiver claims automatically — it's
  read-only and just tells you what to do manually, on purpose (keeps your
  cookies lower-risk and avoids accidental league drama).
