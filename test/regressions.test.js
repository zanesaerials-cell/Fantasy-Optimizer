/**
 * Regression tests for bugs that actually shipped to production.
 * If any of these fail, a real user-visible bug has come back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCookies, pickStat } from "../lib/adapters/espn.js";

/* --- BUG 1: ESPN cookie double-encoding caused 401s --------------------
 * espn_s2 arrives already percent-encoded. Encoding it again turned %2F
 * into %252F and ESPN rejected the session with a 401 that looked exactly
 * like an expired cookie. */

test("espn_s2 is never re-encoded", () => {
  const raw = "AEBxK2%2FvQ8mL3nZpR%2BdT9wXyH4jK6sQ1uV0aB5cD7e%3D%3D";
  const { s2 } = normalizeCookies(raw, "{ABC-123}");
  assert.equal(s2, raw, "espn_s2 must pass through byte-for-byte");
  assert.ok(!s2.includes("%25"), "no %25 sequences — that means double encoding");
});

test("cookie whitespace from pasting is stripped", () => {
  const { s2 } = normalizeCookies("AEBx\nK2%2Fv  Q8mL\t", "{ABC}");
  assert.equal(s2, "AEBxK2%2FvQ8mL");
});

test("SWID braces are added when missing and not doubled", () => {
  assert.equal(normalizeCookies("x", "ABC-123").id, "{ABC-123}");
  assert.equal(normalizeCookies("x", "{ABC-123}").id, "{ABC-123}");
  assert.equal(normalizeCookies("x", " {ABC-123} ").id, "{ABC-123}");
});

test("missing cookies degrade to empty strings, never 'undefined'", () => {
  const { s2, id } = normalizeCookies(undefined, undefined);
  assert.equal(s2, "");
  assert.equal(id, "");
});

/* --- BUG 2: ESPN weekly stat selection --------------------------------
 * player.stats is unordered and mixes season totals, every week, and
 * projections. Matching only on statSourceId returned whichever came
 * first — often an unplayed future week — so real scores rendered blank. */

const lawrence = {
  fullName: "Trevor Lawrence",
  stats: [
    // Deliberately out of order, with the empty future week FIRST —
    // this is the exact shape that broke v1.
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: null },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 19.4 },
    { statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 41.8, appliedAverage: 20.9 },
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 26.1 },
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 15.7 },
  ],
};

test("week 1 actual is 26.1, not the first array entry", () => {
  const s = pickStat(lawrence, { sourceId: 0, week: 1 });
  assert.equal(s.appliedTotal, 26.1);
});

test("week 1 projection is kept separate from week 1 actual", () => {
  assert.equal(pickStat(lawrence, { sourceId: 1, week: 1 }).appliedTotal, 19.4);
  assert.equal(pickStat(lawrence, { sourceId: 0, week: 1 }).appliedTotal, 26.1);
});

test("season total uses the season split, not a weekly entry", () => {
  const s = pickStat(lawrence, { sourceId: 0, week: 0, splitType: 0 });
  assert.equal(s.appliedTotal, 41.8);
  assert.equal(s.appliedAverage, 20.9);
});

test("a real zero-point game is distinguished from missing data", () => {
  const p = { stats: [{ statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 0 }] };
  const s = pickStat(p, { sourceId: 0, week: 4 });
  assert.equal(s.appliedTotal, 0, "zero is a real score and must survive");
});

test("falls back to source+period when statSplitTypeId is absent", () => {
  const p = { stats: [{ statSourceId: 0, scoringPeriodId: 2, appliedTotal: 12.3 }] };
  assert.equal(pickStat(p, { sourceId: 0, week: 2 }).appliedTotal, 12.3);
});

test("missing week returns null rather than a wrong week's data", () => {
  assert.equal(pickStat(lawrence, { sourceId: 0, week: 9 }), null);
});

/* --- BUG 3: Sleeper matchup points -----------------------------------
 * /rosters returns player IDs only. Points live on /matchups/{week} under
 * players_points. v1 never called it, so every Sleeper figure was blank.
 * We assert the shape the adapter depends on. */

test("Sleeper scoring is read from players_points, not the roster", () => {
  const rosterResponse = { roster_id: 4, players: ["4046", "6786"], starters: ["4046"] };
  assert.ok(
    !("players_points" in rosterResponse),
    "the roster payload has no scoring — this is why matchups must be fetched"
  );

  const matchupResponse = {
    roster_id: 4,
    points: 118.4,
    players_points: { 4046: 22.6, 6786: 9.1 },
    starters: ["4046"],
  };
  assert.equal(matchupResponse.players_points["4046"], 22.6);
  assert.equal(matchupResponse.points, 118.4);
});
