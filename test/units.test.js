import { test } from "node:test";
import assert from "node:assert/strict";

import { optimize, analyzeLineup, validateLineup } from "../lib/optimizer.js";
import { project, preferenceValue, SOURCE } from "../lib/projections.js";
import { slotAccepts, normalizeStatus, normalizePosition, canonicalKey, STATUS } from "../lib/domain.js";
import { rankWaiverTargets, benchPointsHistory, analyzeTrade, winProbability, waiverBuckets, MEANINGFUL_UPGRADE } from "../lib/analysis/index.js";
import { loadLeagueConfigs } from "../lib/config.js";

function P(name, position, points, extra = {}) {
  return {
    canonicalId: canonicalKey({ name, position }),
    name, position,
    status: STATUS.ACTIVE,
    isStarter: false,
    projection: { points, floor: points - 4, ceiling: points + 4, confidence: { level: "HIGH", score: 80, reasons: [] } },
    ...extra,
  };
}

/* ---------- slot eligibility ---------- */

test("FLEX takes RB/WR/TE but never QB", () => {
  assert.ok(slotAccepts("FLEX", "RB"));
  assert.ok(slotAccepts("FLEX", "WR"));
  assert.ok(slotAccepts("FLEX", "TE"));
  assert.ok(!slotAccepts("FLEX", "QB"));
  assert.ok(!slotAccepts("FLEX", "K"));
});

test("SUPER_FLEX takes QB", () => {
  assert.ok(slotAccepts("SUPER_FLEX", "QB"));
  assert.ok(slotAccepts("SUPER_FLEX", "RB"));
});

test("WR/TE slot excludes RB", () => {
  assert.ok(slotAccepts("WR/TE", "WR"));
  assert.ok(slotAccepts("WR/TE", "TE"));
  assert.ok(!slotAccepts("WR/TE", "RB"));
});

/* ---------- optimizer ---------- */

test("dedicated slots are filled before FLEX steals the player", () => {
  // Only one RB exists. If FLEX were filled first it would take him and
  // leave the RB slot empty — the classic greedy bug.
  const players = [P("Only RB", "RB", 20), P("WR One", "WR", 18), P("WR Two", "WR", 15)];
  const { lineup } = optimize(players, ["RB", "WR", "FLEX"]);

  const rbSlot = lineup.find((a) => a.slot === "RB");
  assert.equal(rbSlot.player.name, "Only RB", "RB slot must get the only RB");
  assert.ok(lineup.every((a) => a.player), "no slot left empty");
});

test("SUPERFLEX does not consume the only QB", () => {
  const players = [P("QB One", "QB", 24), P("RB One", "RB", 18), P("RB Two", "RB", 14)];
  const { lineup } = optimize(players, ["QB", "RB", "SUPER_FLEX"]);
  assert.equal(lineup.find((a) => a.slot === "QB").player.name, "QB One");
  assert.equal(lineup.find((a) => a.slot === "SUPER_FLEX").player.position, "RB");
});

test("players who are OUT are never assigned to a starting slot", () => {
  const players = [
    P("Injured Star", "RB", 30, { status: STATUS.OUT }),
    P("Healthy Backup", "RB", 8),
  ];
  const { lineup } = optimize(players, ["RB"]);
  assert.equal(lineup[0].player.name, "Healthy Backup");
});

test("a player on bye is treated as unavailable", () => {
  const players = [P("Bye Guy", "WR", 22, { status: STATUS.BYE }), P("Available", "WR", 9)];
  const { lineup } = optimize(players, ["WR"]);
  assert.equal(lineup[0].player.name, "Available");
});

test("slots with no eligible player come back empty rather than mis-filled", () => {
  const { lineup } = optimize([P("A WR", "WR", 12)], ["WR", "K"]);
  assert.equal(lineup.find((a) => a.slot === "K").player, null);
});

test("optimizer handles an empty roster without throwing", () => {
  const r = optimize([], ["QB", "RB", "FLEX"]);
  assert.equal(r.projectedPoints, 0);
  assert.equal(r.lineup.length, 3);
});

test("multiple FLEX slots are all filled", () => {
  const players = [
    P("RB1", "RB", 20), P("RB2", "RB", 18), P("WR1", "WR", 16),
    P("WR2", "WR", 14), P("TE1", "TE", 12),
  ];
  const { lineup } = optimize(players, ["RB", "WR", "FLEX", "FLEX"]);
  assert.equal(lineup.filter((a) => a.player).length, 4);
});

/* ---------- lineup analysis ---------- */

test("gain is zero when the lineup is already optimal", () => {
  const players = [
    P("Best RB", "RB", 20, { isStarter: true }),
    P("Worse RB", "RB", 5),
  ];
  const a = analyzeLineup(players, ["RB"]);
  assert.equal(a.gain, 0);
  assert.equal(a.moves.length, 0);
});

test("a better bench player produces a swap with the right gain", () => {
  const players = [
    P("Starter", "RB", 8, { isStarter: true }),
    P("Bench Stud", "RB", 18),
  ];
  const a = analyzeLineup(players, ["RB"]);
  assert.equal(a.gain, 10);
  assert.equal(a.moves[0].in.name, "Bench Stud");
  assert.equal(a.moves[0].out.name, "Starter");
});

test("an OUT starter is flagged CRITICAL", () => {
  const players = [P("Hurt", "RB", 15, { isStarter: true, status: STATUS.OUT })];
  const problems = validateLineup(players, ["RB"]);
  assert.equal(problems[0].severity, "CRITICAL");
  assert.equal(problems[0].code, "OUT_STARTER");
});

test("empty starting slots are detected", () => {
  const problems = validateLineup([], ["QB", "RB"]);
  assert.ok(problems.some((p) => p.code === "EMPTY_SLOT"));
});

/* ---------- projections ---------- */

test("projection source hierarchy prefers market over platform", () => {
  const p = project({ weekProjected: 12, seasonAvg: 10 }, [10, 11, 12], 15);
  assert.equal(p.source, SOURCE.MARKET);
  assert.equal(p.points, 15);
});

test("falls back to platform projection when no market data", () => {
  const p = project({ weekProjected: 12, seasonAvg: 10 }, [10, 11, 12], null);
  assert.equal(p.source, SOURCE.PLATFORM);
});

test("falls back to season average as a last resort", () => {
  const p = project({ seasonAvg: 9.5 }, [], null);
  assert.equal(p.source, SOURCE.SEASON);
  assert.equal(p.points, 9.5);
});

test("no data yields a null projection, never a guess", () => {
  const p = project({}, [], null);
  assert.equal(p.points, null);
  assert.equal(p.source, SOURCE.NONE);
});

test("floor and ceiling require at least 3 games of history", () => {
  assert.equal(project({ seasonAvg: 10 }, [10, 12], null).floor, null);
  const withHistory = project({ seasonAvg: 10 }, [4, 10, 16, 12], null);
  assert.ok(withHistory.floor != null && withHistory.ceiling != null);
  assert.ok(withHistory.floor < withHistory.ceiling);
});

test("a volatile player gets a wider range than a consistent one", () => {
  const steady = project({ seasonAvg: 12 }, [12, 12, 12, 12], null);
  const swingy = project({ seasonAvg: 12 }, [2, 24, 3, 25], null);
  assert.ok(swingy.volatility > steady.volatility);
});

test("volatile players score lower confidence", () => {
  const steady = project({ seasonAvg: 12, weekProjected: 12 }, [12, 12, 12, 12, 12, 12], null);
  const swingy = project({ seasonAvg: 12, weekProjected: 12 }, [0, 26, 1, 27], null);
  assert.ok(steady.confidence.score > swingy.confidence.score);
});

test("risk preference shifts valuation without altering the projection", () => {
  const p = { points: 14, floor: 8, ceiling: 22 };
  const cons = preferenceValue(p, "conservative");
  const bal = preferenceValue(p, "balanced");
  const up = preferenceValue(p, "upside");
  assert.ok(cons < bal && bal < up);
  assert.equal(bal, 14);
  assert.equal(p.points, 14, "underlying projection is untouched");
});

/* ---------- normalization ---------- */

test("positions normalize across platform vocabularies", () => {
  assert.equal(normalizePosition("D/ST"), "DEF");
  assert.equal(normalizePosition("DST"), "DEF");
  assert.equal(normalizePosition("PK"), "K");
  assert.equal(normalizePosition("HB"), "RB");
});

test("injury vocabularies normalize", () => {
  assert.equal(normalizeStatus("Q"), STATUS.QUESTIONABLE);
  assert.equal(normalizeStatus("questionable"), STATUS.QUESTIONABLE);
  assert.equal(normalizeStatus("IR"), STATUS.IR);
  assert.equal(normalizeStatus("PUP"), STATUS.IR);
  assert.equal(normalizeStatus(null), STATUS.ACTIVE);
});

test("the same player matches across platforms despite formatting", () => {
  const espn = canonicalKey({ name: "A.J. Brown", position: "WR" });
  const sleeper = canonicalKey({ name: "AJ Brown", position: "WR" });
  assert.equal(espn, sleeper);
});

test("suffixes do not break identity matching", () => {
  assert.equal(
    canonicalKey({ name: "Marvin Harrison Jr.", position: "WR" }),
    canonicalKey({ name: "Marvin Harrison", position: "WR" })
  );
});

test("different players do not collide", () => {
  assert.notEqual(
    canonicalKey({ name: "Josh Allen", position: "QB" }),
    canonicalKey({ name: "Josh Allen", position: "DEF" })
  );
});

/* ---------- waivers ---------- */

test("waiver upgrade is measured against your worst at the position", () => {
  const myRoster = [P("My RB1", "RB", 18), P("My RB2", "RB", 6)];
  const ranked = rankWaiverTargets({
    candidates: [P("FA RB", "RB", 12)],
    myRoster, slots: ["RB", "FLEX"],
  });
  assert.equal(ranked[0].upgrade, 6, "12 minus the 6-point RB2");
  assert.equal(ranked[0].dropCandidate.name, "My RB2");
});

test("a player with no startable slot is flagged", () => {
  const ranked = rankWaiverTargets({
    candidates: [P("A Kicker", "K", 9)],
    myRoster: [P("My K", "K", 8)],
    slots: ["QB", "RB", "WR"],
  });
  assert.ok(ranked[0].reasonsAgainst.some((r) => r.includes("No K slot")));
});

/* ---------- bench points ---------- */

test("bench points measure actual versus optimal, using real results", () => {
  const history = [{
    week: 1,
    players: [
      { canonicalId: "a", name: "Started Dud", position: "RB", status: STATUS.ACTIVE, isStarter: true, weekActual: 4 },
      { canonicalId: "b", name: "Benched Stud", position: "RB", status: STATUS.ACTIVE, isStarter: false, weekActual: 22 },
    ],
  }];
  const r = benchPointsHistory({ weeklyHistory: history, slots: ["RB"] });
  assert.equal(r.weeks[0].actual, 4);
  assert.equal(r.weeks[0].optimal, 22);
  assert.equal(r.weeks[0].left, 18);
  assert.equal(r.totalLeft, 18);
});

test("a perfect lineup leaves zero points on the bench", () => {
  const history = [{
    week: 1,
    players: [
      { canonicalId: "a", name: "Right Call", position: "RB", status: STATUS.ACTIVE, isStarter: true, weekActual: 20 },
      { canonicalId: "b", name: "Correctly Benched", position: "RB", status: STATUS.ACTIVE, isStarter: false, weekActual: 3 },
    ],
  }];
  assert.equal(benchPointsHistory({ weeklyHistory: history, slots: ["RB"] }).totalLeft, 0);
});

/* ---------- trades ---------- */

test("trade analysis reports positional impact, not one number", () => {
  const myTeam = { id: "L-t1", roster: [P("My WR1", "WR", 20), P("My WR2", "WR", 18), P("My RB1", "RB", 6)] };
  const theirTeam = { id: "L-t2", roster: [P("Their RB1", "RB", 19), P("Their WR1", "WR", 5)] };

  const r = analyzeTrade({
    myTeam, theirTeam,
    giveIds: [myTeam.roster[1].canonicalId],
    receiveIds: [theirTeam.roster[0].canonicalId],
    slots: ["RB", "WR"],
  });

  assert.ok(r.myGain > 0, "receiving a much better RB should improve the lineup");
  assert.ok("RB" in r.positional);
  assert.ok(Array.isArray(r.solves));
});

test("an empty trade is rejected rather than scored", () => {
  const t = { id: "x", roster: [] };
  assert.ok(analyzeTrade({ myTeam: t, theirTeam: t, giveIds: [], receiveIds: [], slots: [] }).error);
});

/* ---------- config ---------- */

test("legacy single-league env vars still work", () => {
  const { leagues } = loadLeagueConfigs({
    ESPN_LEAGUE_ID: "2139594506", ESPN_TEAM_ID: "3", ESPN_SEASON: "2026",
    SLEEPER_LEAGUE_ID: "1389719356375580672", SLEEPER_USERNAME: "zane",
  });
  assert.equal(leagues.length, 2);
  assert.equal(leagues[0].id, "espn-2139594506");
});

test("extra leagues are added from the LEAGUES array", () => {
  const { leagues } = loadLeagueConfigs({
    ESPN_LEAGUE_ID: "2139594506",
    LEAGUES: JSON.stringify([{ platform: "espn", leagueId: "998877", teamId: "5", name: "Work" }]),
  });
  assert.equal(leagues.length, 2);
  assert.equal(leagues[1].label, "Work");
});

test("a league listed twice is not duplicated", () => {
  const { leagues } = loadLeagueConfigs({
    ESPN_LEAGUE_ID: "2139594506",
    LEAGUES: JSON.stringify([{ platform: "espn", leagueId: "2139594506" }]),
  });
  assert.equal(leagues.length, 1);
});

test("malformed LEAGUES reports an error instead of crashing", () => {
  const { errors } = loadLeagueConfigs({ LEAGUES: "{not json" });
  assert.ok(errors.length > 0);
});

test("a non-numeric league ID is rejected", () => {
  const { errors } = loadLeagueConfigs({
    LEAGUES: JSON.stringify([{ platform: "espn", leagueId: "../../etc/passwd" }]),
  });
  assert.ok(errors.some((e) => e.includes("not a valid numeric league ID")));
});

test("an unknown platform is rejected", () => {
  const { errors } = loadLeagueConfigs({
    LEAGUES: JSON.stringify([{ platform: "yahoo", leagueId: "123456" }]),
  });
  assert.ok(errors.some((e) => e.includes("espn")));
});

/* ---------- regression: OUT starters must not inflate the current score ---------- */

test("an OUT starter contributes zero to the current lineup score", () => {
  const players = [
    P("Hurt Starter", "RB", 16.5, { isStarter: true, status: STATUS.OUT }),
    P("Healthy Bench", "RB", 11.8),
  ];
  const a = analyzeLineup(players, ["RB"]);
  assert.equal(a.current.projectedPoints, 0, "a player who cannot play scores nothing");
  assert.equal(a.optimal.projectedPoints, 11.8);
  assert.equal(a.gain, 11.8, "the full replacement value is available, not the difference");
});

test("win probability is null without enough variance data", () => {
  const noHistory = optimize([P("A", "RB", 12)], ["RB"]);
  assert.equal(winProbability(noHistory, noHistory), null);
});

test("win probability is a sane percentage when variance exists", () => {
  const withVar = (name, pts, vol) => ({
    ...P(name, "RB", pts),
    projection: { points: pts, volatility: vol, confidence: { level: "HIGH", score: 80, reasons: [] } },
  });
  // A close matchup — a blowout would correctly return 0/100 and tell us
  // nothing about whether the simulation works.
  const slightFavourite = optimize(
    [withVar("A", 18, 6), withVar("B", 15, 5), withVar("C", 13, 5)], ["RB", "RB", "FLEX"]
  );
  const slightUnderdog = optimize(
    [withVar("D", 16, 6), withVar("E", 14, 5), withVar("F", 12, 5)], ["RB", "RB", "FLEX"]
  );

  const favoured = winProbability(slightFavourite, slightUnderdog);
  const underdog = winProbability(slightUnderdog, slightFavourite);

  assert.ok(favoured > 50 && favoured < 100, `favourite should be above even: got ${favoured}`);
  assert.ok(underdog > 0 && underdog < 50, `underdog should be live: got ${underdog}`);
  assert.ok(
    Math.abs(favoured + underdog - 100) < 6,
    `the two sides should roughly complement: ${favoured} + ${underdog}`
  );
});

/* ---------- optimizer: full slot-shape audit (spec phase-2 item 7) ---------- */

test("standard 9-slot roster (QB/RB/RB/WR/WR/TE/FLEX/K/DEF) fills every slot correctly", () => {
  const players = [
    P("QB1", "QB", 22), P("RB1", "RB", 19), P("RB2", "RB", 15), P("RB3", "RB", 9),
    P("WR1", "WR", 18), P("WR2", "WR", 14), P("WR3", "WR", 11),
    P("TE1", "TE", 12), P("TE2", "TE", 6),
    P("K1", "K", 8), P("DEF1", "DEF", 7),
  ];
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
  const { lineup, bench } = optimize(players, slots);

  assert.ok(lineup.every((a) => a.player), "every slot filled");
  assert.equal(lineup.find((a) => a.slot === "K").player.name, "K1");
  assert.equal(lineup.find((a) => a.slot === "DEF").player.name, "DEF1");
  // FLEX should take the best remaining RB/WR/TE after dedicated slots are full:
  // RB3(9) WR3(11) TE2(6) remain — WR3 is the best of those.
  assert.equal(lineup.find((a) => a.slot === "FLEX").player.name, "WR3");
  assert.equal(bench.length, 2, "TE2 and RB3 ride the bench");
});

test("a player with zero projection data is never preferred but doesn't crash the optimizer", () => {
  const noData = { ...P("No Data Guy", "RB", 0), projection: { points: null, floor: null, ceiling: null, confidence: { level: "UNAVAILABLE", score: null, reasons: [] } } };
  const players = [noData, P("Known RB", "RB", 9)];
  const { lineup } = optimize(players, ["RB", "RB"]);
  assert.equal(lineup.find((a) => a.player?.name === "Known RB")?.player.name, "Known RB");
  assert.ok(lineup.every((a) => a.player), "the undated player still fills the second slot rather than being skipped");
});

test("WR/RB/TE flex (multiple, mixed with SUPERFLEX) resolves without stealing dedicated slots", () => {
  const players = [
    P("QB1", "QB", 24), P("QB2", "QB", 18),
    P("RB1", "RB", 20), P("RB2", "RB", 16),
    P("WR1", "WR", 19), P("WR2", "WR", 13), P("WR3", "WR", 10),
    P("TE1", "TE", 11),
  ];
  const slots = ["QB", "RB", "WR", "WR", "FLEX", "SUPER_FLEX"];
  const { lineup } = optimize(players, slots);
  assert.equal(lineup.find((a) => a.slot === "QB").player.name, "QB1");
  // SUPERFLEX should take QB2 (18) over any RB/WR/TE leftover, since it's the highest value left.
  assert.equal(lineup.find((a) => a.slot === "SUPER_FLEX").player.name, "QB2");
});

/* ---------- confidence must never be fabricated from nothing ---------- */

test("zero projection sources yields UNAVAILABLE confidence, not a fake low score", () => {
  const p = project({}, [], null);
  assert.equal(p.points, null);
  assert.equal(p.confidence.level, "UNAVAILABLE");
  assert.equal(p.confidence.score, null, "no numeric score should be invented");
});

test("real data still produces a numeric, graded confidence", () => {
  const p = project({ seasonAvg: 10, weekProjected: 11 }, [8, 9, 10, 11], null);
  assert.ok(typeof p.confidence.score === "number");
  assert.ok(["HIGH", "MEDIUM", "LOW"].includes(p.confidence.level));
});

/* ---------- waivers: meaningful-upgrade gate ---------- */

test("marginal free agents are excluded from the meaningful set", () => {
  const myRoster = [P("My WR", "WR", 12)];
  const ranked = rankWaiverTargets({
    candidates: [P("Barely Better", "WR", 12.8), P("Real Upgrade", "WR", 19)],
    myRoster, slots: ["WR", "FLEX"],
  });
  const barely = ranked.find((r) => r.name === "Barely Better");
  const real = ranked.find((r) => r.name === "Real Upgrade");
  assert.equal(barely.meaningful, false, `0.8 pt bump is noise, not a decision (threshold ${MEANINGFUL_UPGRADE})`);
  assert.equal(real.meaningful, true);
});

test("waiverBuckets reports how many were considered vs how many cleared the bar", () => {
  const myRoster = [P("My RB", "RB", 15)];
  const ranked = rankWaiverTargets({
    candidates: [P("Scrub1", "RB", 15.2), P("Scrub2", "RB", 14.9)],
    myRoster, slots: ["RB"],
  });
  const buckets = waiverBuckets(ranked);
  assert.equal(buckets.consideredCount, 2);
  assert.equal(buckets.meaningfulCount, 0);
  assert.equal(buckets.best.length, 0, "no marginal players should appear in 'best'");
});

/* ---------- regression: a single played week must not read as a confident average ---------- */
/* Found via a real user report: a Sleeper bench player with one game on
 * record (a 0) was showing as "projected 0.0" with no indication that was
 * a sample of one. */

test("one played game (Sleeper-style, no platform seasonAvg) yields no projection, not a false zero", () => {
  const p = project({}, [0], null);
  assert.equal(p.points, null, "a single data point is not an average");
  assert.equal(p.source, SOURCE.NONE);
});

test("one played game with a nonzero score is equally insufficient", () => {
  // Confirms this isn't specific to zero — any n=1 sample is too thin.
  const p = project({}, [14], null);
  assert.equal(p.points, null);
});

test("two played games are enough to report a value, via Recent Form since they're the same two games", () => {
  const p = project({}, [0, 4], null);
  assert.equal(p.points, 2);
  assert.equal(p.source, SOURCE.RECENT, "with only 2 games, recent and season are identical — recent correctly wins");
  assert.equal(p.sourceLabel, "Recent form (2 games)");
});

test("with 4+ games, season average draws on the full history while recent form uses only the last 3", () => {
  const p = project({}, [0, 0, 0, 12], null); // last 3 = [0,0,12] avg 4; full season avg = 3
  assert.equal(p.source, SOURCE.RECENT);
  assert.equal(p.points, 4);
});

test("ESPN's own season average is trusted regardless of local history length", () => {
  // ESPN supplies seasonAvg directly (its appliedAverage), already correct
  // — this must not be gated by our locally-fetched history array, which
  // may be empty on a shallow (non-deep) sync.
  const p = project({ seasonAvg: 11.4 }, [], null);
  assert.equal(p.points, 11.4);
  assert.equal(p.source, SOURCE.SEASON);
  assert.equal(p.sourceLabel, "Season average", "no game count appended for a platform-supplied number");
});

test("recent form still requires two games minimum, matching the season-average floor", () => {
  const p = project({}, [0], null);
  assert.equal(p.points, null);
  const p2 = project({}, [0, 8], null);
  assert.equal(p2.source, SOURCE.RECENT);
});
