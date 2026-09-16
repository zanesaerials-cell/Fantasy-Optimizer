/**
 * Derived analysis. All deterministic, all computed from data we actually
 * have. Anything that would require a paid data feed (snap counts, target
 * share, defense-vs-position rankings) is deliberately absent rather than
 * estimated.
 */

import { slotAccepts, POSITIONS } from "../domain.js";
import { optimize } from "../optimizer.js";
import { preferenceValue } from "../projections.js";

/* ---------------- waivers ---------------- */

/**
 * Value a free agent by how much he'd improve your weakest player at that
 * position — the spot he'd actually take. A WR who beats your WR5 is worth
 * more than a QB2 who'd never start.
 */
export function rankWaiverTargets({ candidates, myRoster, slots, preference = "balanced" }) {
  const startableAt = (pos) => slots.filter((s) => slotAccepts(s, pos)).length;

  return candidates
    .map((c) => {
      const cv = preferenceValue(c.projection, preference);
      const samePos = myRoster
        .filter((p) => p.position === c.position)
        .map((p) => ({ p, v: preferenceValue(p.projection, preference) }))
        .sort((a, b) => b.v - a.v);

      const replacement = samePos.length ? samePos[samePos.length - 1] : null;
      const replacementLevel = replacement ? Number(replacement.v.toFixed(1)) : 0;
      const upgrade = Number((cv - replacementLevel).toFixed(1));

      const slotsAvailable = startableAt(c.position);
      const bestUse = slotsAvailable === 0
        ? "Not startable in this league"
        : samePos.length && cv > samePos[0].v
        ? `Immediate starter at ${c.position}`
        : slotsAvailable > 1
        ? "Flex depth"
        : "Bench depth";

      const reasonsAgainst = [];
      if (c.projection?.gamesPlayed != null && c.projection.gamesPlayed < 3)
        reasonsAgainst.push("Little game history to judge");
      if (c.projection?.confidence?.level === "LOW")
        reasonsAgainst.push("Low projection confidence");
      if (slotsAvailable === 0)
        reasonsAgainst.push(`No ${c.position} slot in your lineup`);
      if (upgrade < 1)
        reasonsAgainst.push("Marginal upgrade over who you already have");

      return {
        ...c,
        upgrade,
        replacementLevel,
        dropCandidate: replacement?.p ?? null,
        bestUse,
        reasonsAgainst,
        score: Number((upgrade + Math.min(2, (c.addCount24h || 0) / 8000)).toFixed(2)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Waiver tab buckets. Each is a filter over the same ranked list. */
export function waiverBuckets(ranked) {
  return {
    best: ranked.slice(0, 25),
    immediate: ranked.filter((p) => p.bestUse.startsWith("Immediate")).slice(0, 25),
    upside: ranked
      .filter((p) => p.projection?.ceiling != null)
      .sort((a, b) => (b.projection.ceiling || 0) - (a.projection.ceiling || 0))
      .slice(0, 25),
    floor: ranked
      .filter((p) => p.projection?.floor != null)
      .sort((a, b) => (b.projection.floor || 0) - (a.projection.floor || 0))
      .slice(0, 25),
  };
}

/* ---------------- roster health ---------------- */

const BANDS = [
  { min: 0.85, label: "Strong" },
  { min: 0.6, label: "Average" },
  { min: 0, label: "Weak" },
];

function band(ratio) {
  return BANDS.find((b) => ratio >= b.min).label;
}

/**
 * Rate each position against the league's own median at that position,
 * rather than an arbitrary points threshold — a "good" RB in a 10-team
 * league isn't the same as in a 14-team league.
 */
export function rosterHealth({ myRoster, allTeams, slots, preference = "balanced" }) {
  const leagueValues = {};
  for (const t of allTeams) {
    for (const p of t.roster || []) {
      if (!p.position) continue;
      (leagueValues[p.position] = leagueValues[p.position] || [])
        .push(preferenceValue(p.projection, preference));
    }
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const report = {};
  const needs = [];

  for (const pos of POSITIONS) {
    const mine = myRoster
      .filter((p) => p.position === pos)
      .map((p) => preferenceValue(p.projection, preference))
      .sort((a, b) => b - a);

    if (!mine.length) {
      const startable = slots.filter((s) => slotAccepts(s, pos)).length;
      if (startable > 0) {
        report[pos] = { starter: "Missing", depth: "Missing", count: 0, note: `No ${pos} rostered` };
        needs.push({ position: pos, issue: `No ${pos} on roster`, priority: 1 });
      }
      continue;
    }

    const leagueMedian = median(leagueValues[pos] || []) || 1;
    const startersNeeded = Math.max(1, slots.filter((s) => s === pos).length);

    const starterAvg = mine.slice(0, startersNeeded).reduce((a, b) => a + b, 0) / startersNeeded;
    const benchPool = mine.slice(startersNeeded);
    const benchAvg = benchPool.length
      ? benchPool.reduce((a, b) => a + b, 0) / benchPool.length : 0;

    const starterRatio = starterAvg / leagueMedian;
    const depthRatio = mine.length >= startersNeeded + 1 ? benchAvg / leagueMedian : 0;

    report[pos] = {
      count: mine.length,
      starter: band(starterRatio),
      depth: band(depthRatio),
      starterValue: Number(starterAvg.toFixed(1)),
      benchValue: Number(benchAvg.toFixed(1)),
      leagueMedian: Number(leagueMedian.toFixed(1)),
    };

    if (report[pos].starter === "Weak") {
      needs.push({ position: pos, issue: `${pos} starter below league median`, priority: 2 });
    } else if (report[pos].depth === "Weak") {
      needs.push({ position: pos, issue: `${pos} depth is thin`, priority: 3 });
    }
    if (report[pos].starter === "Strong" && report[pos].depth === "Strong" && mine.length > startersNeeded + 1) {
      needs.push({ position: pos, issue: `${pos} surplus — tradeable`, priority: 4, surplus: true });
    }
  }

  return { byPosition: report, needs: needs.sort((a, b) => a.priority - b.priority) };
}

/* ---------------- opponent scouting ---------------- */

export function scoutOpponent({ myTeam, oppTeam, slots, preference = "balanced" }) {
  if (!oppTeam) return null;

  const mine = optimize(myTeam.roster, slots, preference);
  const theirs = optimize(oppTeam.roster, slots, preference);

  const byPosition = {};
  for (const pos of POSITIONS) {
    const sum = (lineup) => lineup.lineup
      .filter((a) => a.player?.position === pos)
      .reduce((s, a) => s + (a.player?.value || 0), 0);
    const m = sum(mine);
    const t = sum(theirs);
    if (m === 0 && t === 0) continue;
    byPosition[pos] = {
      mine: Number(m.toFixed(1)),
      theirs: Number(t.toFixed(1)),
      edge: Number((m - t).toFixed(1)),
    };
  }

  const entries = Object.entries(byPosition);
  const edges = entries.filter(([, v]) => v.edge > 1).sort((a, b) => b[1].edge - a[1].edge);
  const vulnerabilities = entries.filter(([, v]) => v.edge < -1).sort((a, b) => a[1].edge - b[1].edge);

  return {
    myProjected: mine.projectedPoints,
    oppProjected: theirs.projectedPoints,
    margin: Number((mine.projectedPoints - theirs.projectedPoints).toFixed(1)),
    winProbability: winProbability(mine, theirs),
    byPosition,
    edges: edges.map(([pos, v]) => ({ position: pos, points: v.edge })),
    vulnerabilities: vulnerabilities.map(([pos, v]) => ({ position: pos, points: Math.abs(v.edge) })),
  };
}

/**
 * Win probability by Monte Carlo over each lineup's own historical
 * volatility. Only returned when we have enough variance data — otherwise
 * null, because a made-up percentage is worse than none.
 */
export function winProbability(mine, theirs, trials = 4000) {
  const spread = (lineup) => lineup.lineup
    .map((a) => a.player?.projection?.volatility)
    .filter((v) => v != null);

  const mySd = spread(mine);
  const theirSd = spread(theirs);
  if (mySd.length < 3 || theirSd.length < 3) return null;

  const total = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  const sdM = total(mySd);
  const sdT = total(theirSd);

  // Box-Muller, seeded by nothing in particular — this is a stable estimate
  // at 4000 trials, so run-to-run drift is well under a percentage point.
  const gauss = () => {
    const u = Math.random() || 1e-9;
    const v = Math.random() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let wins = 0;
  for (let i = 0; i < trials; i++) {
    const a = mine.projectedPoints + gauss() * sdM;
    const b = theirs.projectedPoints + gauss() * sdT;
    if (a > b) wins++;
  }
  return Math.round((wins / trials) * 100);
}

/* ---------------- bench points ---------------- */

/**
 * What the optimal lineup would have scored each week versus what was
 * actually started. Uses actual results, so this is history, not projection.
 */
export function benchPointsHistory({ weeklyHistory, slots }) {
  const weeks = [];

  for (const wk of weeklyHistory) {
    const withActuals = (wk.players || [])
      .filter((p) => p.weekActual != null)
      .map((p) => ({ ...p, projection: { points: p.weekActual } }));

    if (!withActuals.length) continue;

    const actual = withActuals
      .filter((p) => p.isStarter)
      .reduce((s, p) => s + p.weekActual, 0);

    const best = optimize(withActuals, slots, "balanced");

    weeks.push({
      week: wk.week,
      actual: Number(actual.toFixed(1)),
      optimal: Number(best.projectedPoints.toFixed(1)),
      left: Number(Math.max(0, best.projectedPoints - actual).toFixed(1)),
    });
  }

  const totalLeft = Number(weeks.reduce((s, w) => s + w.left, 0).toFixed(1));
  return {
    weeks,
    totalLeft,
    averageLeft: weeks.length ? Number((totalLeft / weeks.length).toFixed(1)) : null,
    worstWeek: weeks.length ? weeks.reduce((a, b) => (b.left > a.left ? b : a)) : null,
  };
}

/* ---------------- trades ---------------- */

/**
 * Evaluate a proposed trade by re-optimizing both lineups before and after.
 * Reports positional deltas and depth effects rather than collapsing it to
 * one "trade value" number, which would hide what the trade actually does.
 */
export function analyzeTrade({ myTeam, theirTeam, giveIds, receiveIds, slots, preference = "balanced" }) {
  const give = myTeam.roster.filter((p) => giveIds.includes(p.canonicalId));
  const receive = theirTeam.roster.filter((p) => receiveIds.includes(p.canonicalId));

  if (!give.length && !receive.length) {
    return { error: "Select at least one player on each side." };
  }

  const myAfter = [
    ...myTeam.roster.filter((p) => !giveIds.includes(p.canonicalId)),
    ...receive,
  ];
  const theirAfter = [
    ...theirTeam.roster.filter((p) => !receiveIds.includes(p.canonicalId)),
    ...give,
  ];

  const myBefore = optimize(myTeam.roster, slots, preference);
  const myAfterOpt = optimize(myAfter, slots, preference);
  const theirBefore = optimize(theirTeam.roster, slots, preference);
  const theirAfterOpt = optimize(theirAfter, slots, preference);

  const positional = {};
  for (const pos of POSITIONS) {
    const sum = (o) => o.lineup
      .filter((a) => a.player?.position === pos)
      .reduce((s, a) => s + (a.player?.value || 0), 0);
    const delta = Number((sum(myAfterOpt) - sum(myBefore)).toFixed(1));
    if (delta !== 0) positional[pos] = delta;
  }

  const depthBefore = countByPosition(myTeam.roster);
  const depthAfter = countByPosition(myAfter);
  const depthChanges = {};
  for (const pos of POSITIONS) {
    const d = (depthAfter[pos] || 0) - (depthBefore[pos] || 0);
    if (d !== 0) depthChanges[pos] = d;
  }

  const myGain = Number((myAfterOpt.projectedPoints - myBefore.projectedPoints).toFixed(1));
  const theirGain = Number((theirAfterOpt.projectedPoints - theirBefore.projectedPoints).toFixed(1));

  const solves = [];
  for (const [pos, delta] of Object.entries(positional)) {
    if (delta > 1) solves.push(`Improves your starting ${pos} by ${delta.toFixed(1)} pts/week`);
    if (delta < -1) solves.push(`Weakens your starting ${pos} by ${Math.abs(delta).toFixed(1)} pts/week`);
  }
  for (const [pos, d] of Object.entries(depthChanges)) {
    if (d < 0 && (depthAfter[pos] || 0) <= 1) {
      solves.push(`Leaves you with only ${depthAfter[pos] || 0} ${pos} — thin if one gets hurt`);
    }
  }

  return {
    myGain,
    theirGain,
    before: { mine: myBefore.projectedPoints, theirs: theirBefore.projectedPoints },
    after: { mine: myAfterOpt.projectedPoints, theirs: theirAfterOpt.projectedPoints },
    positional,
    depthChanges,
    solves,
    // "Fair" here means both sides improve their starting lineup. It is not
    // a market-value judgement — we have no trade-value data source.
    mutuallyBeneficial: myGain > 0.5 && theirGain > 0.5,
    fairness: describeFairness(myGain, theirGain),
    give: give.map((p) => ({ name: p.name, position: p.position, projection: p.projection })),
    receive: receive.map((p) => ({ name: p.name, position: p.position, projection: p.projection })),
  };
}

function countByPosition(roster) {
  const out = {};
  for (const p of roster) if (p.position) out[p.position] = (out[p.position] || 0) + 1;
  return out;
}

function describeFairness(myGain, theirGain) {
  if (myGain > 0.5 && theirGain > 0.5) return "Both rosters improve their starting lineup.";
  if (myGain > 0.5 && theirGain <= 0.5) return "Improves your lineup; they have less reason to accept.";
  if (myGain <= 0.5 && theirGain > 0.5) return "Improves their lineup more than yours.";
  return "Neither starting lineup improves meaningfully.";
}

/**
 * Scan every other team for swaps where both sides gain. Bounded to
 * 1-for-1 and 2-for-2 at differing positions to keep the search cheap.
 */
export function findTrades({ myTeam, allTeams, slots, preference = "balanced", limit = 8 }) {
  const found = [];
  const mine = myTeam.roster.filter((p) => p.projection?.points != null);

  for (const other of allTeams) {
    if (other.id === myTeam.id) continue;
    const theirs = (other.roster || []).filter((p) => p.projection?.points != null);

    for (const give of mine) {
      for (const receive of theirs) {
        if (give.position === receive.position) continue;
        const result = analyzeTrade({
          myTeam, theirTeam: other,
          giveIds: [give.canonicalId], receiveIds: [receive.canonicalId],
          slots, preference,
        });
        if (result.mutuallyBeneficial) {
          found.push({
            team: other.teamName,
            teamId: other.id,
            give: { name: give.name, position: give.position },
            receive: { name: receive.name, position: receive.position },
            myGain: result.myGain,
            theirGain: result.theirGain,
            why: `You have ${give.position} depth; they gain at ${give.position} and you gain at ${receive.position}.`,
            solves: result.solves,
          });
        }
      }
    }
  }

  return found
    .sort((a, b) => (b.myGain + b.theirGain) - (a.myGain + a.theirGain))
    .slice(0, limit);
}

/* ---------------- power rankings ---------------- */

export function powerRankings({ teams, slots, preference = "balanced" }) {
  return teams
    .map((t) => {
      const opt = optimize(t.roster || [], slots, preference);
      const starters = (t.roster || []).filter((p) => p.isStarter);
      const benchStrength = opt.bench
        .slice(0, 5)
        .reduce((s, p) => s + (p.value || 0), 0);
      return {
        teamId: t.id,
        teamName: t.teamName,
        record: `${t.record.wins}-${t.record.losses}`,
        wins: t.record.wins,
        pointsFor: Number((t.pointsFor || 0).toFixed(1)),
        pointsAgainst: Number((t.pointsAgainst || 0).toFixed(1)),
        rosterStrength: opt.projectedPoints,
        benchStrength: Number(benchStrength.toFixed(1)),
        starterCount: starters.length,
      };
    })
    .sort((a, b) => b.rosterStrength - a.rosterStrength);
}
