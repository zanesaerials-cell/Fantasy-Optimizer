/**
 * Lineup optimizer.
 *
 * Handles any slot configuration the league defines — SUPERFLEX, several
 * FLEX slots, WR/TE, IDP — because slots are described by which positions
 * they accept rather than hardcoded.
 *
 * Deterministic. No LLM anywhere in this file, per the spec: the math is
 * the math, and an AI layer should only ever explain the result.
 */

import { slotAccepts, slotBreadth, isOut, isRisky, STATUS } from "./domain.js";
import { preferenceValue } from "./projections.js";

/**
 * Greedy assignment, narrowest slots first.
 *
 * Why this is correct here: process slots in ascending order of how many
 * positions they accept, and at each step take the highest-value eligible
 * player. A dedicated QB slot is filled before SUPERFLEX, so SUPERFLEX
 * can't steal the only QB. With the small, nested position sets fantasy
 * uses (FLEX ⊂ SUPERFLEX, etc.) this produces the optimal assignment.
 */
export function optimize(players, slots, preference = "balanced") {
  const pool = players
    .filter((p) => p.position)
    .map((p) => ({ ...p, value: preferenceValue(p.projection, preference) }))
    .sort((a, b) => b.value - a.value);

  const order = slots
    .map((slot, index) => ({ slot, index, breadth: slotBreadth(slot) }))
    .sort((a, b) => a.breadth - b.breadth || a.index - b.index);

  const used = new Set();
  const assigned = new Array(slots.length).fill(null);

  for (const { slot, index } of order) {
    const pick = pool.find(
      (p) => !used.has(p.canonicalId) &&
             slotAccepts(slot, p.position) &&
             !isOut(p.status)
    );
    if (pick) used.add(pick.canonicalId);
    assigned[index] = { slot, player: pick || null };
  }

  const bench = pool.filter((p) => !used.has(p.canonicalId));
  const projectedPoints = Number(
    assigned.reduce((s, a) => s + (a.player?.value || 0), 0).toFixed(1)
  );

  return { lineup: assigned, bench, projectedPoints, preference };
}

/**
 * Score whatever lineup is actually set right now.
 *
 * A starter who is OUT, on IR, suspended or on bye contributes zero — not
 * their projection. Crediting them would overstate the current lineup and
 * make the "points available" figure look smaller than it really is.
 */
export function scoreCurrentLineup(players, preference = "balanced") {
  const starters = players.filter((p) => p.isStarter);
  const points = Number(
    starters
      .reduce((s, p) => s + (isOut(p.status) ? 0 : preferenceValue(p.projection, preference)), 0)
      .toFixed(1)
  );
  return { starters, projectedPoints: points };
}

/**
 * Structural problems with the lineup as set. These are facts, not
 * opinions, so they always outrank optimization suggestions.
 */
export function validateLineup(players, slots) {
  const problems = [];
  const starters = players.filter((p) => p.isStarter);

  for (const p of starters) {
    if (p.status === STATUS.BYE) {
      problems.push({ code: "BYE_STARTER", player: p, severity: "CRITICAL",
        message: `${p.name} is on bye and will score zero.` });
    } else if (isOut(p.status)) {
      problems.push({ code: "OUT_STARTER", player: p, severity: "CRITICAL",
        message: `${p.name} is ${p.status} and will score zero.` });
    } else if (isRisky(p.status)) {
      problems.push({ code: "RISKY_STARTER", player: p, severity: "HIGH",
        message: `${p.name} is ${p.status.toLowerCase()}.` });
    }
  }

  const emptySlots = slots.length - starters.length;
  if (emptySlots > 0) {
    problems.push({ code: "EMPTY_SLOT", severity: "CRITICAL", player: null,
      message: `${emptySlots} starting ${emptySlots === 1 ? "slot is" : "slots are"} empty.` });
  }

  return problems;
}

/**
 * Diff current vs optimal into explicit moves. Pairs a bench-in with a
 * start-out at the same position where possible so the advice reads as a
 * single swap rather than two unrelated instructions.
 */
export function diffLineups(current, optimal) {
  const optimalIds = new Set(optimal.lineup.map((a) => a.player?.canonicalId).filter(Boolean));
  const currentIds = new Set(current.starters.map((p) => p.canonicalId));

  const promote = optimal.lineup
    .filter((a) => a.player && !currentIds.has(a.player.canonicalId))
    .map((a) => ({ player: a.player, toSlot: a.slot }));
  const demote = current.starters.filter((p) => !optimalIds.has(p.canonicalId));

  const pool = [...demote];
  const moves = [];

  for (const { player: inPlayer, toSlot } of promote) {
    let idx = pool.findIndex((p) => p.position === inPlayer.position);
    if (idx < 0) idx = pool.findIndex((p) => slotAccepts(toSlot, p.position));
    const outPlayer = idx >= 0 ? pool.splice(idx, 1)[0] : null;

    const inVal = inPlayer.value ?? inPlayer.projection?.points ?? 0;
    const outVal = outPlayer ? (outPlayer.value ?? outPlayer.projection?.points ?? 0) : 0;

    moves.push({
      in: inPlayer,
      out: outPlayer,
      slot: toSlot,
      gain: Number((inVal - outVal).toFixed(1)),
      inProjection: inPlayer.projection,
      outProjection: outPlayer?.projection ?? null,
    });
  }

  // Anything left over is a straight benching with no replacement.
  for (const outPlayer of pool) {
    moves.push({
      in: null, out: outPlayer, slot: null,
      gain: 0, inProjection: null, outProjection: outPlayer.projection,
    });
  }

  return moves.sort((a, b) => b.gain - a.gain);
}

/**
 * The full picture for a team: what's set, what's optimal, what to change,
 * and what's structurally broken.
 */
export function analyzeLineup(players, slots, preference = "balanced") {
  const current = scoreCurrentLineup(players, preference);
  const optimal = optimize(players, slots, preference);
  const moves = diffLineups(current, optimal);
  const problems = validateLineup(players, slots);

  return {
    current: { projectedPoints: current.projectedPoints, starters: current.starters },
    optimal: { projectedPoints: optimal.projectedPoints, lineup: optimal.lineup, bench: optimal.bench },
    gain: Number((optimal.projectedPoints - current.projectedPoints).toFixed(1)),
    moves: moves.filter((m) => m.in || m.out),
    problems,
    preference,
  };
}
