/**
 * Recommendation engine.
 *
 * Severity is deterministic — defined by the rules below, not by how
 * dramatic something looks. Every recommendation carries the inputs that
 * produced it so the UI's "Why?" button has real data to show.
 */

import { isOut, isRisky, STATUS } from "./domain.js";

export const SEVERITY = { CRITICAL: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

export const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Point thresholds that separate a big lineup gain from a rounding error. */
export const THRESHOLDS = {
  MAJOR_GAIN: 5.0,
  MINOR_GAIN: 2.0,
  NOISE: 0.75,
  MAJOR_WAIVER: 4.0,
  MINOR_WAIVER: 1.5,
};

let seq = 0;
function id(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function base({ league, team, type, severity, action, reason, impact, confidence, why, link }) {
  return {
    id: id(type),
    leagueId: league.id,
    leagueName: league.name,
    platform: league.platform,
    teamName: team.teamName,
    teamId: team.id,
    type,
    severity,
    action,
    reason,
    impact,
    confidence,
    why: why || [],
    link: link || `/league/${league.id}`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Turn a lineup analysis into recommendations.
 *
 * Ordering rule: structural problems (a player who literally cannot score)
 * always come before optimization suggestions, however large the point
 * gain on the latter.
 */
export function fromLineup({ league, team, analysis }) {
  const out = [];

  for (const problem of analysis.problems) {
    if (problem.code === "EMPTY_SLOT") {
      out.push(base({
        league, team, type: "lineup-empty", severity: SEVERITY.CRITICAL,
        action: problem.message,
        reason: "An empty starting slot scores nothing.",
        impact: null,
        confidence: { level: "HIGH", score: 100, reasons: ["Roster state is unambiguous"] },
        why: [{ label: "Slots configured", value: String(analysis.current.starters.length) }],
      }));
      continue;
    }

    const p = problem.player;
    const replacement = analysis.moves.find((m) => m.out?.canonicalId === p?.canonicalId)?.in;

    if (problem.severity === "CRITICAL") {
      out.push(base({
        league, team, type: "lineup-out", severity: SEVERITY.CRITICAL,
        action: replacement
          ? `Replace ${p.name} with ${replacement.name}`
          : `Bench ${p.name}`,
        reason: problem.message,
        impact: replacement?.projection?.points != null
          ? { points: replacement.projection.points, unit: "projected pts recovered" }
          : null,
        confidence: { level: "HIGH", score: 95, reasons: ["Official injury designation"] },
        why: [
          { label: "Status", value: p.status },
          ...(replacement ? [{
            label: "Replacement projection",
            value: `${replacement.projection?.points ?? "—"} (${replacement.projection?.sourceLabel ?? "no data"})`,
          }] : []),
        ],
      }));
    } else if (problem.severity === "HIGH") {
      const projected = p.projection?.points ?? 0;
      // A questionable scrub isn't urgent; a questionable stud is.
      const severity = projected >= 10 ? SEVERITY.HIGH : SEVERITY.MEDIUM;
      out.push(base({
        league, team, type: "lineup-risk", severity,
        action: `Monitor ${p.name}`,
        reason: `${problem.message} Check inactives about 90 minutes before kickoff.`,
        impact: { points: projected, unit: "projected pts at risk" },
        confidence: { level: "MEDIUM", score: 60, reasons: ["Game-time decision"] },
        why: [
          { label: "Status", value: p.status },
          { label: "Projection", value: String(projected) },
        ],
      }));
    }
  }

  // Optimization moves worth acting on.
  for (const move of analysis.moves) {
    if (!move.in || move.gain < THRESHOLDS.NOISE) continue;
    const severity =
      move.gain >= THRESHOLDS.MAJOR_GAIN ? SEVERITY.HIGH :
      move.gain >= THRESHOLDS.MINOR_GAIN ? SEVERITY.MEDIUM : SEVERITY.LOW;

    const conf = move.inProjection?.confidence || { level: "LOW", score: 30, reasons: [] };

    out.push(base({
      league, team, type: "lineup-swap", severity,
      action: move.out
        ? `Start ${move.in.name} over ${move.out.name}`
        : `Start ${move.in.name} at ${move.slot}`,
      reason: move.out
        ? `${move.in.name} projects ${move.in.projection?.points} vs ${move.out.projection?.points ?? "—"} for ${move.out.name}.`
        : `${move.in.name} fills an open ${move.slot}.`,
      impact: { points: move.gain, unit: "projected pts" },
      confidence: conf,
      why: [
        { label: `${move.in.name} projection`,
          value: `${move.in.projection?.points ?? "—"} (${move.in.projection?.sourceLabel ?? "no data"})` },
        ...(move.in.projection?.floor != null ? [{
          label: "Floor / ceiling",
          value: `${move.in.projection.floor} – ${move.in.projection.ceiling}` }] : []),
        ...(move.out ? [{ label: `${move.out.name} projection`,
          value: `${move.out.projection?.points ?? "—"} (${move.out.projection?.sourceLabel ?? "no data"})` }] : []),
        { label: "Net change", value: `+${move.gain} projected pts` },
        ...conf.reasons.map((r) => ({ label: "Confidence factor", value: r })),
      ],
    }));
  }

  return out;
}

/** Waiver opportunities that clear the "actually worth a claim" bar. */
export function fromWaivers({ league, team, targets }) {
  const out = [];
  for (const t of targets.slice(0, 6)) {
    if (!t.meaningful) continue;
    const severity = t.upgrade >= THRESHOLDS.MAJOR_WAIVER ? SEVERITY.HIGH : SEVERITY.MEDIUM;
    out.push(base({
      league, team, type: "waiver", severity,
      action: `Add ${t.position} ${t.name}`,
      reason: t.dropCandidate
        ? `Upgrades your ${t.position} group. Likely drop: ${t.dropCandidate.name}.`
        : `Upgrades your ${t.position} group.`,
      impact: { points: t.upgrade, unit: "projected pts/week" },
      confidence: t.projection?.confidence || { level: "LOW", score: 30, reasons: ["Limited data on free agents"] },
      link: `/league/${league.id}?tab=waivers`,
      why: [
        { label: "Projection", value: `${t.projection?.points ?? "—"} (${t.projection?.sourceLabel ?? "no data"})` },
        { label: "Your current worst at position", value: String(t.replacementLevel ?? "—") },
        ...(t.percentOwned != null ? [{ label: "Rostered", value: `${Math.round(t.percentOwned)}%` }] : []),
        ...(t.addCount24h != null ? [{ label: "Added league-wide (24h)", value: String(t.addCount24h) }] : []),
      ],
    }));
  }
  return out;
}

/** Matchup context. Informational unless the gap is large. */
export function fromMatchup({ league, team, matchup, myProjected, oppProjected }) {
  if (!matchup || oppProjected == null) return [];
  const diff = Number((myProjected - oppProjected).toFixed(1));
  const pct = oppProjected ? Math.abs(diff) / oppProjected : 0;
  if (pct < 0.05) return [];

  return [base({
    league, team, type: "matchup",
    severity: diff < 0 && pct > 0.1 ? SEVERITY.MEDIUM : SEVERITY.LOW,
    action: diff < 0
      ? `You're projected to lose to ${matchup.oppName}`
      : `You're projected to beat ${matchup.oppName}`,
    reason: `${myProjected} projected against ${oppProjected}.`,
    impact: { points: diff, unit: "projected margin" },
    confidence: { level: "MEDIUM", score: 55, reasons: ["Based on current projections for both rosters"] },
    link: `/league/${league.id}?tab=opponent`,
    why: [
      { label: "Your projected total", value: String(myProjected) },
      { label: "Opponent projected total", value: String(oppProjected) },
      { label: "Margin", value: `${diff > 0 ? "+" : ""}${diff}` },
    ],
  })];
}

export function sortByUrgency(recs) {
  return [...recs].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return (b.impact?.points ?? 0) - (a.impact?.points ?? 0);
  });
}

export function summarize(recs) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of recs) counts[r.severity] = (counts[r.severity] || 0) + 1;
  return {
    counts,
    total: recs.length,
    needsAttention: counts.CRITICAL + counts.HIGH,
  };
}
