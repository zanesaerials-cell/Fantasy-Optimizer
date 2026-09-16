/**
 * ESPN adapter.
 *
 * REGRESSION GUARDS — both of these were real production bugs. Tests in
 * test/regressions.test.js pin them. Do not "simplify" either one:
 *
 *  1. Cookie encoding. espn_s2 arrives already percent-encoded. Calling
 *     encodeURIComponent on it produces %25xx and a 401 that looks exactly
 *     like an expired session. Never encode it.
 *
 *  2. Stat selection. player.stats is an unordered array mixing season
 *     totals, every individual week, and projections. Matching only on
 *     statSourceId returns whichever came first — often an unplayed future
 *     week, which is why real scores showed as blank. Match on all three
 *     of statSourceId / statSplitTypeId / scoringPeriodId, and always send
 *     an explicit scoringPeriodId in the request.
 */

import { cached, TTL } from "../cache.js";
import {
  makePlayer, normalizePosition, unsupported, supported, STATUS, normalizeStatus,
} from "../domain.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

export function normalizeCookies(espnS2, swid) {
  const s2 = String(espnS2 || "").trim().replace(/\s+/g, "");
  let id = String(swid || "").trim().replace(/\s+/g, "");
  if (id && !id.startsWith("{")) id = `{${id}`;
  if (id && !id.endsWith("}")) id = `${id}}`;
  return { s2, id };
}

function headers(extra = {}) {
  const { s2, id } = normalizeCookies(process.env.ESPN_S2, process.env.ESPN_SWID);
  return {
    Cookie: `espn_s2=${s2}; SWID=${id}`,
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    ...extra,
  };
}

export class EspnError extends Error {
  constructor(status, message, causes) {
    super(message);
    this.name = "EspnError";
    this.status = status;
    this.causes = causes || [];
    this.platform = "espn";
  }
}

async function get(url, extraHeaders) {
  const res = await fetch(url, { headers: headers(extraHeaders) });
  if (res.ok) return res.json();

  if (res.status === 401) {
    throw new EspnError(401, "ESPN rejected the session.", [
      "The espn_s2 cookie was truncated or wrapped when pasted into Vercel",
      "espn_s2 and SWID came from different browser sessions",
      "You logged out of ESPN elsewhere, which invalidates the cookie early",
    ]);
  }
  if (res.status === 404) {
    throw new EspnError(404, "ESPN has no such league for that season.", [
      "ESPN_LEAGUE_ID is wrong",
      "ESPN_SEASON points at a year this league didn't play",
    ]);
  }
  throw new EspnError(res.status, `ESPN returned ${res.status}.`, [
    "ESPN's fantasy API is intermittently unavailable, especially Sunday mornings",
  ]);
}

/* ---------- stat selection (guarded) ---------- */

export function pickStat(player, { sourceId = 0, week = 0, splitType = null }) {
  const entries = player?.stats || [];
  const wantSplit = splitType !== null ? splitType : week === 0 ? 0 : 1;
  return (
    entries.find(
      (s) => s.statSourceId === sourceId &&
             s.scoringPeriodId === week &&
             s.statSplitTypeId === wantSplit
    ) ||
    entries.find((s) => s.statSourceId === sourceId && s.scoringPeriodId === week) ||
    null
  );
}

const val = (s) => (s && s.appliedTotal != null ? s.appliedTotal : null);

/* ---------- id maps ---------- */

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

const SLOT = {
  0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "SUPER_FLEX",
  16: "DEF", 17: "K", 20: "BENCH", 21: "IR", 23: "FLEX",
};

const TEAM = {
  0: null, 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR",
  15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI",
  22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
  29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

/* ---------- adapter ---------- */

export class EspnAdapter {
  constructor(config) {
    this.config = config;
    this.platform = "espn";
    this.season = config.season;
    this.leagueId = config.platformLeagueId;
  }

  get configured() {
    return Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);
  }

  async raw(week) {
    const views = ["mRoster", "mTeam", "mMatchup", "mSettings", "mStats"]
      .map((v) => `view=${v}`).join("&");
    const url = `${BASE}/${this.season}/segments/0/leagues/${this.leagueId}?scoringPeriodId=${week}&${views}`;
    return cached(`espn:league:${this.leagueId}:${this.season}:${week}`, TTL.MATCHUP, () => get(url));
  }

  async getCurrentWeek() {
    const url = `${BASE}/${this.season}/segments/0/leagues/${this.leagueId}?view=mSettings`;
    const j = await cached(
      `espn:week:${this.leagueId}:${this.season}`, TTL.MATCHUP, () => get(url)
    );
    return j.scoringPeriodId || j.status?.currentMatchupPeriod || 1;
  }

  async getLeague(week) {
    const j = await this.raw(week);
    const s = j.settings || {};
    return {
      id: this.config.id,
      platform: "espn",
      platformLeagueId: this.leagueId,
      name: this.config.label || s.name || "ESPN League",
      season: this.season,
      currentWeek: j.scoringPeriodId || week,
      teamCount: s.size ?? (j.teams || []).length,
      scoringSettings: this.getScoringSettings(j),
      rosterSlots: this.getRosterSettings(j),
      leagueType: s.draftSettings?.keeperCount > 0 ? "keeper" : "redraft",
      playoffTeamCount: s.scheduleSettings?.playoffTeamCount ?? null,
    };
  }

  getScoringSettings(j) {
    const items = j?.settings?.scoringSettings?.scoringItems || [];
    const byId = Object.fromEntries(items.map((i) => [i.statId, i.points]));
    return {
      passYd: byId[3] ?? 0.04, passTd: byId[4] ?? 4, passInt: byId[20] ?? -2,
      rushYd: byId[24] ?? 0.1, rushTd: byId[25] ?? 6,
      recYd: byId[42] ?? 0.1, rec: byId[53] ?? 0, recTd: byId[43] ?? 6,
    };
  }

  getRosterSettings(j) {
    const counts = j?.settings?.rosterSettings?.lineupSlotCounts || {};
    const slots = [];
    for (const [slotId, count] of Object.entries(counts)) {
      const label = SLOT[Number(slotId)];
      if (!label || label === "BENCH" || label === "IR") continue;
      for (let i = 0; i < count; i++) slots.push(label);
    }
    return slots;
  }

  normalizeRosterPlayer(entry, week) {
    const p = entry.playerPoolEntry?.player || entry.player || {};
    const seasonStat = pickStat(p, { sourceId: 0, week: 0, splitType: 0 });
    const player = makePlayer({
      platform: "espn",
      platformId: p.id,
      name: p.fullName,
      position: POS[p.defaultPositionId],
      proTeam: TEAM[p.proTeamId],
      status: p.injuryStatus,
    });
    return {
      ...player,
      slot: SLOT[entry.lineupSlotId] ?? "BENCH",
      isStarter: entry.lineupSlotId != null && entry.lineupSlotId !== 20 && entry.lineupSlotId !== 21,
      weekActual: val(pickStat(p, { sourceId: 0, week })),
      weekProjected: val(pickStat(p, { sourceId: 1, week })),
      seasonTotal: seasonStat?.appliedTotal ?? null,
      seasonAvg: seasonStat?.appliedAverage ?? null,
      percentOwned: p.ownership?.percentOwned ?? null,
    };
  }

  async getTeams(week) {
    const j = await this.raw(week);
    return (j.teams || []).map((t) => ({
      id: `${this.config.id}-t${t.id}`,
      leagueId: this.config.id,
      platformTeamId: String(t.id),
      teamName: t.name || `${t.location || ""} ${t.nickname || ""}`.trim() || `Team ${t.id}`,
      ownerName: t.primaryOwner || null,
      record: {
        wins: t.record?.overall?.wins ?? 0,
        losses: t.record?.overall?.losses ?? 0,
        ties: t.record?.overall?.ties ?? 0,
      },
      rank: t.playoffSeed ?? null,
      pointsFor: t.record?.overall?.pointsFor ?? 0,
      pointsAgainst: t.record?.overall?.pointsAgainst ?? 0,
      roster: (t.roster?.entries || []).map((e) => this.normalizeRosterPlayer(e, week)),
    }));
  }

  async getMatchup(teamId, week) {
    const j = await this.raw(week);
    const m = (j.schedule || []).find(
      (g) => g.matchupPeriodId === week &&
             (g.home?.teamId === Number(teamId) || g.away?.teamId === Number(teamId))
    );
    if (!m) return null;
    const isHome = m.home?.teamId === Number(teamId);
    const opp = isHome ? m.away : m.home;
    const teams = j.teams || [];
    const nameOf = (id) => {
      const t = teams.find((x) => x.id === id);
      return t?.name || `${t?.location || ""} ${t?.nickname || ""}`.trim() || "Opponent";
    };
    return {
      week,
      myScore: (isHome ? m.home : m.away)?.totalPoints ?? 0,
      oppScore: opp?.totalPoints ?? 0,
      oppTeamId: opp?.teamId != null ? String(opp.teamId) : null,
      oppName: opp?.teamId != null ? nameOf(opp.teamId) : "Bye",
    };
  }

  /** Every prior week's actuals, for variance and bench-points math. */
  async getWeeklyHistory(teamId, throughWeek) {
    const weeks = Array.from({ length: Math.max(0, throughWeek) }, (_, i) => i + 1);
    const results = await Promise.all(
      weeks.map((w) =>
        this.raw(w)
          .then((j) => {
            const t = (j.teams || []).find((x) => String(x.id) === String(teamId));
            if (!t) return null;
            return {
              week: w,
              players: (t.roster?.entries || []).map((e) => this.normalizeRosterPlayer(e, w)),
            };
          })
          .catch(() => null)
      )
    );
    return results.filter(Boolean);
  }

  async getWaivers(week, limit = 150) {
    const filter = {
      players: {
        filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
        limit,
        offset: 0,
        sortPercOwned: { sortAsc: false, sortPriority: 1 },
      },
    };
    const url = `${BASE}/${this.season}/segments/0/leagues/${this.leagueId}?scoringPeriodId=${week}&view=kona_player_info`;
    try {
      const j = await cached(
        `espn:fa:${this.leagueId}:${this.season}:${week}`, TTL.PROJECTIONS,
        () => get(url, { "x-fantasy-filter": JSON.stringify(filter) })
      );
      return supported(
        (j.players || [])
          .map((e) => this.normalizeRosterPlayer(e, week))
          .filter((p) => p.name && p.name !== "Unknown")
      );
    } catch (e) {
      return unsupported("waivers", "espn", e.message);
    }
  }

  async getTransactions() {
    // ESPN's transaction view is inconsistent across league configurations
    // and often returns nothing for private leagues. Rather than show an
    // empty list that looks broken, say so.
    return unsupported(
      "transactions", "espn",
      "ESPN's transaction endpoint is unreliable for private leagues."
    );
  }
}
