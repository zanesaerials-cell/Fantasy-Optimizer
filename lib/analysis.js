// Lineup optimization + start/sit reasoning.

const FLEX_ELIGIBLE = ["RB", "WR", "TE"];
const SUPERFLEX_ELIGIBLE = ["QB", "RB", "WR", "TE"];

export function slotAccepts(slot, position) {
  const s = String(slot).toUpperCase();
  if (s === position) return true;
  if (s === "FLEX" || s === "WRT" || s === "REC_FLEX" || s === "RB/WR/TE")
    return FLEX_ELIGIBLE.includes(position);
  if (s === "SUPER_FLEX" || s === "SFLEX" || s === "OP")
    return SUPERFLEX_ELIGIBLE.includes(position);
  if (s === "RB/WR") return ["RB", "WR"].includes(position);
  if (s === "WR/TE") return ["WR", "TE"].includes(position);
  if (s === "DEF" || s === "D/ST") return position === "DEF" || position === "D/ST";
  return false;
}

/**
 * The value we rank a player by, in priority order:
 *   1. market-implied points from sportsbook props (sharpest)
 *   2. platform weekly projection
 *   3. season average
 * Returns { value, source } so the UI can show where the number came from.
 */
export function playerValue(p) {
  if (p.marketPoints != null) return { value: p.marketPoints, source: "market" };
  if (p.weekProjected != null) return { value: p.weekProjected, source: "projection" };
  if (p.seasonAvg != null) return { value: p.seasonAvg, source: "average" };
  return { value: 0, source: "none" };
}

const OUT_STATUSES = ["OUT", "IR", "DOUBTFUL", "SUSPENSION", "NA", "PUP"];

export function isUnavailable(p) {
  const s = String(p.injuryStatus || "").toUpperCase();
  return OUT_STATUSES.includes(s);
}

/**
 * Greedy optimizer: fill the most restrictive slots first (a QB slot only
 * takes QBs; FLEX takes three positions), so flex ends up with genuine
 * leftovers rather than eating a player a dedicated slot needed.
 */
export function optimizeLineup(players, slots) {
  const pool = players
    .filter((p) => p.position && p.position !== "-")
    .map((p) => ({ ...p, ...playerValue(p) }))
    .sort((a, b) => b.value - a.value);

  const flexiness = (slot) =>
    pool.filter((p) => slotAccepts(slot, p.position)).length;

  const ordered = slots
    .map((slot, i) => ({ slot, i, breadth: flexiness(slot) }))
    .sort((a, b) => a.breadth - b.breadth);

  const taken = new Set();
  const assigned = new Array(slots.length).fill(null);

  for (const { slot, i } of ordered) {
    const pick = pool.find(
      (p) => !taken.has(p.playerId) && slotAccepts(slot, p.position) && !isUnavailable(p)
    );
    if (pick) {
      taken.add(pick.playerId);
      assigned[i] = { slot, player: pick };
    } else {
      assigned[i] = { slot, player: null };
    }
  }

  const bench = pool.filter((p) => !taken.has(p.playerId));
  const projectedTotal = assigned.reduce(
    (sum, a) => sum + (a.player?.value || 0),
    0
  );
  return { lineup: assigned, bench, projectedTotal: Number(projectedTotal.toFixed(1)) };
}

/** Compare the optimal lineup to what's actually set, and explain gaps. */
export function buildRecommendations({ currentStarters, optimal, allPlayers }) {
  const recs = [];
  const optimalIds = new Set(optimal.lineup.map((a) => a.player?.playerId).filter(Boolean));
  const currentIds = new Set(currentStarters.map((p) => p.playerId));

  const shouldAdd = optimal.lineup
    .map((a) => a.player)
    .filter((p) => p && !currentIds.has(p.playerId));
  const shouldSit = currentStarters.filter((p) => !optimalIds.has(p.playerId));

  // Pair them up by position where we can, so the advice is a real swap.
  const sitPool = [...shouldSit];
  for (const add of shouldAdd) {
    const matchIdx = sitPool.findIndex((s) => s.position === add.position);
    const drop = matchIdx >= 0 ? sitPool.splice(matchIdx, 1)[0] : sitPool.shift();
    const addV = playerValue(add);
    const dropV = drop ? playerValue(drop) : { value: 0, source: "none" };
    const gain = Number((addV.value - dropV.value).toFixed(1));
    recs.push({
      type: gain > 0 ? "start_sit" : "start_sit_minor",
      priority: gain >= 4 ? "high" : gain >= 1.5 ? "medium" : "low",
      add: add.name,
      addPoints: addV.value,
      drop: drop?.name ?? "empty slot",
      dropPoints: dropV.value,
      gain,
      source: addV.source,
      message: drop
        ? `Start ${add.name} over ${drop.name}`
        : `Start ${add.name} — you have an empty slot`,
      detail: `${addV.value.toFixed(1)} vs ${dropV.value.toFixed(1)} projected · +${gain.toFixed(1)} pts`,
    });
  }

  for (const p of currentStarters) {
    if (isUnavailable(p)) {
      recs.push({
        type: "injury",
        priority: "high",
        message: `${p.name} is ${p.injuryStatus}`,
        detail: "Replace before kickoff or you'll take a zero.",
      });
    } else if (String(p.injuryStatus || "").toUpperCase() === "QUESTIONABLE") {
      recs.push({
        type: "injury",
        priority: "medium",
        message: `${p.name} is questionable`,
        detail: "Check the inactives report about 90 minutes before kickoff.",
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority]);
}

/**
 * Waiver scoring. Combines how much a player would upgrade your weakest
 * starter at that position with how hard the league is chasing him.
 */
export function scoreWaiverTarget(candidate, myRoster) {
  const cv = playerValue(candidate).value;
  const samePos = myRoster
    .filter((p) => p.position === candidate.position)
    .map((p) => playerValue(p).value)
    .sort((a, b) => b - a);

  // Compare against the worst player you'd actually roster at the spot.
  const replacementLevel = samePos.length ? samePos[samePos.length - 1] : 0;
  const upgrade = cv - replacementLevel;

  const trendBoost = Math.min(3, (candidate.addCount24h || 0) / 5000);
  const rosterBoost = candidate.percentOwned != null
    ? Math.min(2, candidate.percentOwned / 25)
    : 0;

  return {
    score: Number((upgrade + trendBoost + rosterBoost).toFixed(2)),
    upgrade: Number(upgrade.toFixed(1)),
    replacementLevel: Number(replacementLevel.toFixed(1)),
  };
}

export const POSITION_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"];
