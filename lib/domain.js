/**
 * Platform-independent domain model.
 *
 * ESPN and Sleeper disagree about almost everything: player IDs, position
 * names, slot names, injury vocabulary, how scoring settings are keyed.
 * Everything above the adapter layer speaks only this vocabulary.
 */

/* ---------- positions ---------- */

export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

const POSITION_ALIASES = {
  "D/ST": "DEF", DST: "DEF", "DEF/ST": "DEF", DEFENSE: "DEF",
  PK: "K", KICKER: "K",
  HB: "RB", FB: "RB", RB: "RB",
  WR: "WR", TE: "TE", QB: "QB",
};

export function normalizePosition(raw) {
  if (!raw) return null;
  const k = String(raw).toUpperCase().trim();
  return POSITION_ALIASES[k] || (POSITIONS.includes(k) ? k : k);
}

/* ---------- lineup slots ---------- */

/**
 * A slot is described by which positions it accepts, so we never hardcode
 * "standard" rosters. SUPERFLEX, multiple FLEX, WR/TE, IDP, taxi — all just
 * become a slot with an accepts[] list.
 */
export const SLOT_DEFINITIONS = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  "RB/WR": ["RB", "WR"],
  "WR/TE": ["WR", "TE"],
  "RB/WR/TE": ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
  DL: ["DL"], LB: ["LB"], DB: ["DB"],
};

/** Non-scoring slots. Players here are not in the active lineup. */
export const RESERVE_SLOTS = ["BENCH", "IR", "TAXI"];

export function slotAccepts(slot, position) {
  if (!slot || !position) return false;
  const s = String(slot).toUpperCase();
  if (RESERVE_SLOTS.includes(s)) return true;
  const accepts = SLOT_DEFINITIONS[s];
  if (accepts) return accepts.includes(position);
  return s === position;
}

/** How many positions a slot accepts — used to fill narrow slots first. */
export function slotBreadth(slot) {
  const s = String(slot).toUpperCase();
  return (SLOT_DEFINITIONS[s] || [s]).length;
}

/* ---------- injury status ---------- */

export const STATUS = {
  ACTIVE: "ACTIVE",
  QUESTIONABLE: "QUESTIONABLE",
  DOUBTFUL: "DOUBTFUL",
  OUT: "OUT",
  IR: "IR",
  SUSPENDED: "SUSPENDED",
  BYE: "BYE",
  UNKNOWN: "UNKNOWN",
};

const STATUS_ALIASES = {
  ACTIVE: STATUS.ACTIVE, "": STATUS.ACTIVE, NORMAL: STATUS.ACTIVE,
  Q: STATUS.QUESTIONABLE, QUESTIONABLE: STATUS.QUESTIONABLE,
  D: STATUS.DOUBTFUL, DOUBTFUL: STATUS.DOUBTFUL,
  O: STATUS.OUT, OUT: STATUS.OUT, INACTIVE: STATUS.OUT,
  IR: STATUS.IR, INJURY_RESERVE: STATUS.IR, PUP: STATUS.IR, NA: STATUS.IR,
  SUSPENSION: STATUS.SUSPENDED, SUSPENDED: STATUS.SUSPENDED,
  BYE: STATUS.BYE,
};

export function normalizeStatus(raw) {
  if (raw == null) return STATUS.ACTIVE;
  return STATUS_ALIASES[String(raw).toUpperCase().trim()] || STATUS.UNKNOWN;
}

/** Cannot play this week at all. */
export function isOut(status) {
  return [STATUS.OUT, STATUS.IR, STATUS.SUSPENDED, STATUS.BYE].includes(status);
}

/** Might not play — worth a warning, not an automatic bench. */
export function isRisky(status) {
  return [STATUS.QUESTIONABLE, STATUS.DOUBTFUL].includes(status);
}

/* ---------- player identity ---------- */

/**
 * ESPN player 12345 and Sleeper player 4046 can be the same human. There's
 * no shared ID, so we match on a normalized name + position + NFL team key.
 * This is imperfect (two players can share a name), so we keep the platform
 * IDs alongside and never discard them.
 */
export function canonicalKey({ name, position, proTeam }) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[.''`,]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const p = normalizePosition(position) || "?";
  // Team is deliberately excluded: players change teams mid-season and we
  // still want them to match across platforms.
  return `${n}|${p}`;
}

export function makePlayer({
  platform, platformId, name, position, proTeam, status, byeWeek, age, yearsExp,
}) {
  const pos = normalizePosition(position);
  return {
    canonicalId: canonicalKey({ name, position: pos, proTeam }),
    platformIds: { [platform]: String(platformId ?? "") },
    name: name || "Unknown",
    position: pos,
    proTeam: proTeam || null,
    status: normalizeStatus(status),
    byeWeek: byeWeek ?? null,
    age: age ?? null,
    yearsExp: yearsExp ?? null,
  };
}

/* ---------- capability signalling ---------- */

/**
 * Adapters return this instead of pretending a feature exists. The UI shows
 * "not available on this platform" rather than an empty list that looks
 * like a bug.
 */
export function unsupported(feature, platform, reason) {
  return { supported: false, feature, platform, reason: reason || null, data: null };
}

export function supported(data) {
  return { supported: true, data };
}
