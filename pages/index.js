import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Shell, Freshness, Empty, Skeleton } from "../components/Shell";
import RecommendationCard from "../components/RecommendationCard";

const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "CRITICAL", label: "Critical" },
  { key: "HIGH", label: "High" },
  { key: "MEDIUM", label: "Medium" },
];

export default function CommandCenter() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback((refresh = false) => {
    if (refresh) setBusy(true); else setLoading(true);
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : (setData(d), setError(null))))
      .catch((e) => setError(e.message))
      .finally(() => { setLoading(false); setBusy(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const leagues = data?.leagues || [];
  const healthy = leagues.filter((l) => l.ok);
  const broken = leagues.filter((l) => !l.ok);

  const recs = (data?.recommendations || []).filter(
    (r) => filter === "all" || r.severity === filter
  );

  const rail = data ? (
    <>
      <div className="h rail-title">This week</div>
      {healthy.map((l) => <MatchupCard key={l.id} league={l} />)}
    </>
  ) : null;

  return (
    <Shell
      leagues={leagues}
      activeNav="home"
      alertCount={data?.summary?.needsAttention || 0}
      rail={rail}
    >
      {loading && <Skeleton count={5} height={92} />}

      {error && (
        <div className="note bad">
          <b>Couldn't load your leagues.</b>
          <p style={{ margin: "6px 0 0" }}>{error}</p>
          <button className="minibtn" style={{ marginTop: 10 }} onClick={() => load()}>Retry</button>
        </div>
      )}

      {data?.configErrors?.length > 0 && (
        <div className="note bad" style={{ marginBottom: 12 }}>
          <b>League configuration problem</b>
          <ul>{data.configErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {data && (
        <>
          <Freshness at={data.syncedAt} onRefresh={() => load(true)} busy={busy} />

          <div className="pulse">
            <Stat value={data.summary.leagueCount} label="Leagues" />
            <Stat
              value={data.summary.counts.CRITICAL}
              label="Critical"
              tone={data.summary.counts.CRITICAL > 0 ? "critical" : null}
            />
            <Stat value={data.summary.counts.HIGH} label="High priority" />
            <Stat
              value={totalGain(healthy)}
              label="Points available"
              prefix="+"
              tone="accent"
            />
          </div>

          {broken.length > 0 && broken.map((l) => <BrokenLeague key={l.id || l.name} league={l} />)}

          <div className="h">
            {data.summary.needsAttention > 0
              ? `${data.summary.needsAttention} thing${data.summary.needsAttention === 1 ? "" : "s"} need your attention`
              : "Nothing urgent"}
          </div>

          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className="chip"
                data-on={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {recs.length === 0 ? (
            <div className="card">
              <Empty glyph="✓">
                {filter === "all"
                  ? "You're set for now. No urgent actions across your leagues."
                  : `Nothing at ${filter.toLowerCase()} priority right now.`}
              </Empty>
            </div>
          ) : (
            recs.map((r) => <RecommendationCard key={r.id} rec={r} />)
          )}

          <div className="h">All leagues</div>
          {healthy.length === 0 && broken.length === 0 ? (
            <div className="card">
              <Empty glyph="○">
                No leagues configured yet. Add <code>ESPN_LEAGUE_ID</code> or{" "}
                <code>SLEEPER_LEAGUE_ID</code> in your Vercel environment variables.
              </Empty>
            </div>
          ) : (
            <div className="list">
              {healthy.map((l) => (
                <Link href={`/league/${l.id}`} key={l.id} className="row">
                  <span className="slot">{l.platform === "espn" ? "ESPN" : "SLP"}</span>
                  <span className="pmain">
                    <span className="pname">{l.name}</span>
                    <span className="pmeta">
                      {l.teamName} · {l.record}
                      {l.matchup && ` · vs ${l.matchup.oppName}`}
                    </span>
                  </span>
                  <span className="pstat">
                    {l.alerts.needsAttention > 0 ? (
                      <span className="sevchip" data-sev={l.alerts.counts.CRITICAL > 0 ? "CRITICAL" : "HIGH"}>
                        {l.alerts.needsAttention}
                      </span>
                    ) : (
                      <span className="sub" style={{ color: "var(--accent)" }}>Clear</span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {/* On mobile the rail collapses, so matchups render inline here. */}
          <div className="mobile-matchups">
            <div className="h">This week's matchups</div>
            {healthy.some((l) => l.matchup)
              ? healthy.filter((l) => l.matchup).map((l) => <MatchupCard key={l.id} league={l} />)
              : <div className="card"><Empty glyph="○">No matchups are live right now.</Empty></div>}
          </div>

          <p className="freshness" style={{ marginTop: 18 }}>
            Projections come from {data.leagues.find((l) => l.ok) ? "your platforms" : "—"}, with
            market data used when an odds key is configured. Sources are shown per player.
          </p>
        </>
      )}

      <style jsx>{`
        @media (min-width: 900px) { .mobile-matchups { display: none; } }
      `}</style>
    </Shell>
  );
}

function Stat({ value, label, prefix = "", tone }) {
  const color = tone === "critical" ? "var(--critical)" : tone === "accent" ? "var(--accent)" : undefined;
  return (
    <div className="pulse-stat">
      <div className="num v" style={{ color }}>{prefix}{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function MatchupCard({ league }) {
  const m = league.matchup;
  if (!m) return null;
  const mine = m.myProjected ?? m.myScore;
  const theirs = m.oppProjected ?? m.oppScore;
  const total = (mine || 0) + (theirs || 0);
  const mineShare = total ? ((mine || 0) / total) * 100 : 50;

  return (
    <div className="card" style={{ marginBottom: 9 }}>
      <div className="matchrow">
        <div>
          <div className="who">{league.teamName}</div>
          <div className="num sc">{fmt(m.myScore)}</div>
          {m.myProjected != null && <div className="wp">{fmt(m.myProjected)} projected</div>}
        </div>
        <div style={{ fontSize: 11, color: "var(--dim)" }}>vs</div>
        <div className="right">
          <div className="who">{m.oppName}</div>
          <div className="num sc">{fmt(m.oppScore)}</div>
          {m.oppProjected != null && <div className="wp">{fmt(m.oppProjected)} projected</div>}
        </div>
      </div>
      <div style={{ padding: "0 12px 12px" }}>
        <div className="bar">
          <i style={{ width: `${mineShare}%`, background: "var(--accent)" }} />
          <i style={{ width: `${100 - mineShare}%`, background: "var(--border)" }} />
        </div>
        {m.winProbability != null && (
          <div className="wp" style={{ marginTop: 6 }}>
            {m.winProbability}% win probability, from each roster's weekly scoring variance
          </div>
        )}
      </div>
    </div>
  );
}

function BrokenLeague({ league }) {
  return (
    <div className="note bad" style={{ marginBottom: 10 }}>
      <b>{league.name || "A league"} isn't syncing</b>
      <p style={{ margin: "6px 0 0" }}>{league.error}</p>
      {league.causes?.length > 0 && (
        <>
          <p style={{ margin: "8px 0 0", color: "var(--text)" }}>Likely causes:</p>
          <ul>{league.causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </>
      )}
      {league.needsIdentity && league.choices && (
        <>
          <p style={{ margin: "8px 0 0", color: "var(--text)" }}>Teams in this league:</p>
          <ul>{league.choices.map((c) => <li key={c.id}><code>{c.id}</code> — {c.name}</li>)}</ul>
        </>
      )}
      <a className="minibtn" href="/api/diagnose" style={{ marginTop: 10, display: "inline-block" }}>
        Check connection
      </a>
    </div>
  );
}

function totalGain(leagues) {
  return leagues.reduce((s, l) => s + Math.max(0, l.lineupGain || 0), 0).toFixed(1);
}

function fmt(n) {
  return n == null ? "—" : Number(n).toFixed(1);
}
