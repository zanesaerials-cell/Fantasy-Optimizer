/**
 * Two-tier cache.
 *
 * Tier 1 is an in-process Map. On Vercel this survives only as long as a
 * warm lambda instance, which is still enough to stop a single page load
 * from fetching the 5MB Sleeper player dictionary three times.
 *
 * Tier 2 is optional Upstash Redis over its REST API. We use plain fetch
 * rather than the @upstash/redis package so this adds no dependency. If
 * the env vars aren't set, tier 2 is skipped silently and everything still
 * works — just with a colder cache and no cross-request snapshots.
 */

const mem = new Map();

export const TTL = {
  PLAYER_METADATA: 24 * 60 * 60 * 1000,
  LEAGUE_SETTINGS: 12 * 60 * 60 * 1000,
  STANDINGS: 30 * 60 * 1000,
  PROJECTIONS: 20 * 60 * 1000,
  MATCHUP: 10 * 60 * 1000,
  INJURY: 10 * 60 * 1000,
  TRANSACTIONS: 30 * 60 * 1000,
  HISTORICAL: 6 * 60 * 60 * 1000,
};

const stats = { hits: 0, misses: 0, errors: 0 };

export function cacheStats() {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    hitRate: total ? Number((stats.hits / total).toFixed(3)) : null,
    entries: mem.size,
    persistent: redisConfigured(),
  };
}

function redisConfigured() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

async function redis(command) {
  if (!redisConfigured()) return null;
  try {
    const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.result ?? null;
  } catch {
    stats.errors++;
    return null;
  }
}

/** Fetch-through cache. `fn` only runs on a miss. */
export async function cached(key, ttl, fn) {
  const now = Date.now();

  const hit = mem.get(key);
  if (hit && now - hit.at < ttl) {
    stats.hits++;
    return hit.value;
  }

  if (redisConfigured()) {
    const raw = await redis(["GET", key]);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (now - parsed.at < ttl) {
          stats.hits++;
          mem.set(key, parsed);
          return parsed.value;
        }
      } catch { /* fall through to refetch */ }
    }
  }

  stats.misses++;
  const value = await fn();
  const entry = { at: now, value };
  mem.set(key, entry);

  if (redisConfigured()) {
    // Keep it in Redis a bit past its TTL so stale-while-revalidate works.
    await redis(["SET", key, JSON.stringify(entry), "PX", String(ttl * 3)]);
  }
  return value;
}

/** Durable key/value for snapshots. Returns null when Redis isn't set up. */
export async function persistGet(key) {
  if (!redisConfigured()) return null;
  const raw = await redis(["GET", key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function persistSet(key, value, ttlMs = 14 * 24 * 60 * 60 * 1000) {
  if (!redisConfigured()) return false;
  await redis(["SET", key, JSON.stringify(value), "PX", String(ttlMs)]);
  return true;
}

export { redisConfigured };
