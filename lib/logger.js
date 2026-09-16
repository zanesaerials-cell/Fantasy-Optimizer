/**
 * Minimal structured logging. The one rule that matters: secrets never
 * reach the log. We scrub anything that looks like a cookie or key before
 * it's serialized, so an accidental `log.error("failed", { headers })`
 * can't leak ESPN_S2 into Vercel's log drain.
 */

const SECRET_KEYS = /^(espn_?s2|swid|cookie|authorization|token|apikey|api_key|odds_api_key|.*_secret)$/i;
const SECRET_ENV = ["ESPN_S2", "ESPN_SWID", "ODDS_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "ANTHROPIC_API_KEY"];

export function redact(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value == null) return value;

  if (typeof value === "string") {
    let out = value;
    for (const name of SECRET_ENV) {
      const secret = process.env[name];
      if (secret && secret.length > 8 && out.includes(secret)) {
        out = out.split(secret).join(`[redacted:${name}]`);
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, message, meta) {
  const line = {
    level,
    message: redact(message),
    ...(meta ? { meta: redact(meta) } : {}),
    at: new Date().toISOString(),
  };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const log = {
  info: (m, meta) => emit("info", m, meta),
  warn: (m, meta) => emit("warn", m, meta),
  error: (m, meta) => emit("error", m, meta),
};

/** Times an async operation and logs the duration. */
export async function timed(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(`${name} ok`, { ms: Date.now() - start });
    return result;
  } catch (e) {
    log.error(`${name} failed`, { ms: Date.now() - start, error: e.message });
    throw e;
  }
}
