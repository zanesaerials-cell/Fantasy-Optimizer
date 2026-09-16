// Visit /api/diagnose to find out exactly what's wrong with your config.
// Never prints cookie values — only lengths, shapes and pass/fail checks.

import { normalizeCookies } from "../../lib/adapters/espn.js";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

export default async function handler(req, res) {
  const {
    ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID, ESPN_SEASON, ESPN_TEAM_ID,
    SLEEPER_LEAGUE_ID, SLEEPER_USERNAME, ODDS_API_KEY,
  } = process.env;

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  /* ---- env var presence ---- */
  add("ESPN_S2 set", Boolean(ESPN_S2), ESPN_S2 ? `${ESPN_S2.length} chars` : "missing");
  add("ESPN_SWID set", Boolean(ESPN_SWID), ESPN_SWID ? `${ESPN_SWID.length} chars` : "missing");
  add("ESPN_LEAGUE_ID set", Boolean(ESPN_LEAGUE_ID), ESPN_LEAGUE_ID || "missing");
  add("ESPN_TEAM_ID set", Boolean(ESPN_TEAM_ID), ESPN_TEAM_ID || "missing (report will list valid IDs)");
  add("SLEEPER_LEAGUE_ID set", Boolean(SLEEPER_LEAGUE_ID), SLEEPER_LEAGUE_ID || "missing");
  add("SLEEPER_USERNAME set", Boolean(SLEEPER_USERNAME), SLEEPER_USERNAME || "missing");
  add("ODDS_API_KEY set", Boolean(ODDS_API_KEY), ODDS_API_KEY ? "present (optional)" : "absent — market projections disabled (optional)");

  /* ---- cookie shape ---- */
  if (ESPN_S2) {
    const raw = ESPN_S2;
    const hasWhitespace = /\s/.test(raw);
    const doubleEncoded = /%25[0-9A-Fa-f]{2}/.test(raw);
    const looksEncoded = /%[0-9A-Fa-f]{2}/.test(raw);

    add("espn_s2 has no whitespace/newlines", !hasWhitespace,
      hasWhitespace ? "Contains whitespace — Vercel's textarea may have wrapped it. Re-paste as one line." : "clean");
    add("espn_s2 not double-encoded", !doubleEncoded,
      doubleEncoded ? "Found %25 sequences — this value was URL-encoded twice. Paste the raw value from DevTools." : "ok");
    add("espn_s2 length plausible", raw.length > 100,
      raw.length > 100 ? `${raw.length} chars` : `only ${raw.length} chars — real values are 300+. Likely truncated on copy.`);
    add("espn_s2 percent-encoding present", looksEncoded,
      looksEncoded ? "ok (normal)" : "no % sequences — unusual but not necessarily wrong");
  }

  if (ESPN_SWID) {
    const braced = ESPN_SWID.trim().startsWith("{") && ESPN_SWID.trim().endsWith("}");
    add("SWID has curly braces", braced, braced ? "ok" : "missing braces — the app adds them automatically, but add them in Vercel too");
    add("SWID looks like a GUID", /[0-9A-Fa-f-]{30,}/.test(ESPN_SWID), "shape check");
  }

  /* ---- live ESPN auth test ---- */
  if (ESPN_S2 && ESPN_SWID && ESPN_LEAGUE_ID) {
    const season = Number(ESPN_SEASON) || new Date().getFullYear();
    const { s2, id } = normalizeCookies(ESPN_S2, ESPN_SWID);
    const url = `${BASE}/${season}/segments/0/leagues/${ESPN_LEAGUE_ID}?view=mTeam`;
    try {
      const r = await fetch(url, {
        headers: {
          Cookie: `espn_s2=${s2}; SWID=${id}`,
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        },
      });
      add(`ESPN API responds (season ${season})`, r.ok, `HTTP ${r.status}`);
      if (r.ok) {
        const j = await r.json();
        const teams = (j.teams || []).map((t) => ({
          teamId: t.id,
          teamName: t.name || `${t.location || ""} ${t.nickname || ""}`.trim(),
        }));
        add("Teams found", teams.length > 0, `${teams.length} teams`);
        if (ESPN_TEAM_ID) {
          const match = teams.find((t) => String(t.teamId) === String(ESPN_TEAM_ID));
          add("ESPN_TEAM_ID matches a team", Boolean(match),
            match ? match.teamName : `No team with ID ${ESPN_TEAM_ID}. Valid: ${teams.map((t) => t.teamId).join(", ")}`);
        }
        checks.push({ name: "ESPN teams", ok: true, teams });
      } else if (r.status === 401) {
        add("ESPN auth", false,
          "401 with cleaned cookies. Log out of ESPN everywhere, log back in, and copy BOTH cookies fresh from the same browser session.");
      }
    } catch (e) {
      add("ESPN API reachable", false, e.message);
    }
  }

  /* ---- live Sleeper test ---- */
  if (SLEEPER_LEAGUE_ID) {
    try {
      const r = await fetch(`https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}`);
      add("Sleeper league found", r.ok, r.ok ? (await r.json()).name : `HTTP ${r.status}`);
      const u = await fetch(`https://api.sleeper.app/v1/league/${SLEEPER_LEAGUE_ID}/users`);
      if (u.ok) {
        const users = await u.json();
        const names = users.map((x) => x.display_name);
        if (SLEEPER_USERNAME) {
          const hit = names.some((n) => n?.toLowerCase() === SLEEPER_USERNAME.toLowerCase());
          add("SLEEPER_USERNAME matches a manager", hit,
            hit ? "ok" : `No match. Managers: ${names.join(", ")}`);
        } else {
          add("Sleeper managers", true, names.join(", "));
        }
      }
    } catch (e) {
      add("Sleeper API reachable", false, e.message);
    }
  }

  const failed = checks.filter((c) => c.ok === false);
  res.status(200).json({
    summary: failed.length ? `${failed.length} check(s) failed` : "All checks passed",
    failed: failed.map((c) => `${c.name}: ${c.detail}`),
    checks,
  });
}
