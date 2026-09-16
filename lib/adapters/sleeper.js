/**
 * Sleeper adapter. Sleeper's API is public — no auth.
 *
 * REGRESSION GUARD: /league/{id}/rosters returns player IDs only, with no
 * scoring whatsoever. Points live on /league/{id}/matchups/{week} under
 * players_points. v1 never called it, so every Sleeper number rendered
 * blank. Pinned by test/regressions.test.js.
 */

import { cached, TTL } from "../cache.js";
import { makePlayer, unsupported, supported } from "../domain.js";

const BASE = "https://api.sleeper.app/v1";

export class SleeperError extends Error {
  constructor(status, message, causes) {
    super(message);
    this.name = "SleeperError";
    this.status = status;
    this.causes = causes || [];
    this.platform = "sleeper";
  }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (res.ok) return res.json();
  if (res.status === 404) {
    throw new SleeperError(404, "Sleeper has no such league.", [
      "SLEEPER_LEAGUE_ID is wrong — copy it from the league URL",
    ]);
  }
  throw new SleeperError(res.status, `Sleeper returned ${res.status}.`, [
    "Sleeper's API is rate limited; try again shortly",
  ]);
}

/** ~5MB and changes about once a day. Cached hard. */
async function playerDictionary() {
  return cached("sleeper:players", TTL.PLAYER_METADATA, () => get("/players/nfl"));
}

export class SleeperAdapter {
  constructor(config) {
    this.config = config;
    this.platform = "sleeper";
    this.leagueId = config.platformLeagueId;
    this.username = config.username;
  }

  get configured() { return true; }

  async getCurrentWeek() {
    const s = await cached("sleeper:state", TTL.MATCHUP, () => get("/state/nfl"));
    return s?.week || 1;
  }

  async leagueRaw() {
    return cached(`sleeper:league:${this.leagueId}`, TTL.LEAGUE_SETTINGS,
      () => get(`/league/${this.leagueId}`));
  }

  async getLeague(week) {
    const l = await this.leagueRaw();
    return {
      id: this.config.id,
      platform: "sleeper",
      platformLeagueId: this.leagueId,
      name: this.config.label || l.name || "Sleeper League",
      season: Number(l.season) || this.config.season,
      currentWeek: week,
      teamCount: l.total_rosters ?? null,
      scoringSettings: this.getScoringSettings(l),
      rosterSlots: this.getRosterSettings(l),
      leagueType:
        l.settings?.type === 2 ? "dynasty" : l.settings?.type === 1 ? "keeper" : "redraft",
      playoffTeamCount: l.settings?.playoff_teams ?? null,
      taxiSlots: l.settings?.taxi_slots ?? 0,
    };
  }

  getScoringSettings(l) {
    const s = l?.scoring_settings || {};
    return {
      passYd: s.pass_yd ?? 0.04, passTd: s.pass_td ?? 4, passInt: s.pass_int ?? -2,
      rushYd: s.rush_yd ?? 0.1, rushTd: s.rush_td ?? 6,
      recYd: s.rec_yd ?? 0.1, rec: s.rec ?? 0, recTd: s.rec_td ?? 6,
    };
  }

  getRosterSettings(l) {
    const map = { WRRB_FLEX: "RB/WR", REC_FLEX: "WR/TE", SUPER_FLEX: "SUPER_FLEX", FLEX: "FLEX" };
    return (l?.roster_positions || [])
      .filter((p) => !["BN", "IR", "TAXI"].includes(p))
      .map((p) => map[p] || p);
  }

  async matchups(week) {
    return cached(`sleeper:matchups:${this.leagueId}:${week}`, TTL.MATCHUP,
      () => get(`/league/${this.leagueId}/matchups/${week}`).catch(() => []));
  }

  normalizePlayer(pid, dict, pointsMap = {}) {
    const p = dict[pid];
    if (!p) {
      return { ...makePlayer({ platform: "sleeper", platformId: pid, name: String(pid) }),
               weekActual: pointsMap[pid] ?? null };
    }
    const name = p.position === "DEF"
      ? `${p.team || pid} Defense`
      : p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    return {
      ...makePlayer({
        platform: "sleeper", platformId: pid, name,
        position: p.position, proTeam: p.team,
        status: p.injury_status, age: p.age, yearsExp: p.years_exp,
      }),
      weekActual: pointsMap[pid] ?? null,
      searchRank: p.search_rank ?? null,
    };
  }

  async getTeams(week) {
    const [rosters, users, dict, ms] = await Promise.all([
      cached(`sleeper:rosters:${this.leagueId}`, TTL.STANDINGS,
        () => get(`/league/${this.leagueId}/rosters`)),
      cached(`sleeper:users:${this.leagueId}`, TTL.LEAGUE_SETTINGS,
        () => get(`/league/${this.leagueId}/users`)),
      playerDictionary(),
      this.matchups(week),
    ]);

    const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
    const mByRoster = Object.fromEntries((ms || []).map((m) => [m.roster_id, m]));

    return rosters.map((r) => {
      const m = mByRoster[r.roster_id] || {};
      const pts = m.players_points || {};
      const starters = r.starters || [];
      const u = userById[r.owner_id];
      return {
        id: `${this.config.id}-t${r.roster_id}`,
        leagueId: this.config.id,
        platformTeamId: String(r.roster_id),
        teamName: u?.metadata?.team_name || u?.display_name || "Unknown",
        ownerName: u?.display_name || null,
        record: {
          wins: r.settings?.wins ?? 0,
          losses: r.settings?.losses ?? 0,
          ties: r.settings?.ties ?? 0,
        },
        rank: null,
        pointsFor: r.settings?.fpts ?? 0,
        pointsAgainst: r.settings?.fpts_against ?? 0,
        matchupId: m.matchup_id ?? null,
        weekScore: m.points ?? null,
        roster: (r.players || []).map((pid) => {
          const base = this.normalizePlayer(pid, dict, pts);
          const idx = starters.indexOf(pid);
          const slots = this.getRosterSettings({ roster_positions: null }) || [];
          return {
            ...base,
            isStarter: idx >= 0,
            slot: idx >= 0 ? `S${idx}` : "BENCH",
            starterIndex: idx >= 0 ? idx : null,
          };
        }),
      };
    });
  }

  async getMatchup(teamId, week) {
    const [teams, ms] = await Promise.all([this.getTeams(week), this.matchups(week)]);
    const me = teams.find((t) => t.platformTeamId === String(teamId));
    if (!me || me.matchupId == null) return null;
    const oppEntry = (ms || []).find(
      (m) => m.matchup_id === me.matchupId && String(m.roster_id) !== String(teamId)
    );
    const opp = oppEntry ? teams.find((t) => t.platformTeamId === String(oppEntry.roster_id)) : null;
    return {
      week,
      myScore: me.weekScore ?? 0,
      oppScore: opp?.weekScore ?? 0,
      oppTeamId: opp?.platformTeamId ?? null,
      oppName: opp?.teamName || "Opponent",
    };
  }

  async getWeeklyHistory(teamId, throughWeek) {
    const weeks = Array.from({ length: Math.max(0, throughWeek) }, (_, i) => i + 1);
    const dict = await playerDictionary();
    const results = await Promise.all(
      weeks.map(async (w) => {
        const ms = await this.matchups(w);
        const entry = (ms || []).find((m) => String(m.roster_id) === String(teamId));
        if (!entry) return null;
        const pts = entry.players_points || {};
        const starters = entry.starters || [];
        return {
          week: w,
          actualScore: entry.points ?? null,
          players: Object.keys(pts).map((pid) => ({
            ...this.normalizePlayer(pid, dict, pts),
            isStarter: starters.includes(pid),
          })),
        };
      })
    );
    return results.filter(Boolean);
  }

  async getWaivers(week) {
    const [rosters, dict, trending] = await Promise.all([
      cached(`sleeper:rosters:${this.leagueId}`, TTL.STANDINGS,
        () => get(`/league/${this.leagueId}/rosters`)),
      playerDictionary(),
      cached("sleeper:trending", TTL.PROJECTIONS,
        () => get("/players/nfl/trending/add?lookback_hours=24&limit=100").catch(() => [])),
    ]);
    const rostered = new Set(rosters.flatMap((r) => r.players || []));
    return supported(
      (trending || [])
        .filter((t) => !rostered.has(t.player_id))
        .map((t) => ({ ...this.normalizePlayer(t.player_id, dict), addCount24h: t.count }))
        .filter((p) => p.position)
    );
  }

  async getTransactions(week) {
    try {
      const tx = await cached(`sleeper:tx:${this.leagueId}:${week}`, TTL.TRANSACTIONS,
        () => get(`/league/${this.leagueId}/transactions/${week}`));
      return supported(tx || []);
    } catch (e) {
      return unsupported("transactions", "sleeper", e.message);
    }
  }

  async resolveMyTeamId() {
    if (!this.username) return null;
    const users = await cached(`sleeper:users:${this.leagueId}`, TTL.LEAGUE_SETTINGS,
      () => get(`/league/${this.leagueId}/users`));
    const u = users.find(
      (x) => x.display_name?.toLowerCase() === this.username.toLowerCase() ||
             x.username?.toLowerCase() === this.username.toLowerCase()
    );
    if (!u) return null;
    const rosters = await cached(`sleeper:rosters:${this.leagueId}`, TTL.STANDINGS,
      () => get(`/league/${this.leagueId}/rosters`));
    const r = rosters.find((x) => x.owner_id === u.user_id);
    return r ? String(r.roster_id) : null;
  }

  async listManagers() {
    const users = await cached(`sleeper:users:${this.leagueId}`, TTL.LEAGUE_SETTINGS,
      () => get(`/league/${this.leagueId}/users`));
    return users.map((u) => u.display_name);
  }
}
