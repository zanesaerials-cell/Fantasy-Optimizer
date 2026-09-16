import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Shell, Freshness, Empty, Skeleton } from "../../components/Shell";
import RecommendationCard from "../../components/RecommendationCard";

const TABS = [
  { key: "lineup", label: "Lineup" },
  { key: "moves", label: "Moves" },
  { key: "waivers", label: "Waivers" },
  { key: "opponent", label: "Opponent" },
  { key: "league", label: "League" },
];

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"];

export default function LeaguePage() {
  const router = useRouter();
  const { id, tab } = router.query;

  const [data, setData] = useState(null);
  const [leagues, setLeagues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState("ALL");

  const active = TABS.some((t) => t.key === tab) ? tab : "lineup";

  const load = useCallback((refresh = false) => {
    if (!id) return;
    if (refresh) setBusy(true); else setLoading(true);
    Promise.all([
      fetch(`/api/leagues/${encodeURIComponent(id)}`).then((r) => r.json()),
      fetch("/api/dashboard").then((r) => r.json()).catch(() => null),
    ])
      .then(([league, dash]) => {
        setData(league);
        if (dash?.leagues) setLeagues(dash.leagues);
      })
      .finally(() => { setLoading(false); setBusy(false); });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const setTab = (k) =>
    router.push(`/league/${id}?tab=${k}`, undefined, { shallow: true });

  const navKey = ["lineup", "moves", "waivers", "league"].includes(active) ? active : "lineup";

  return (
    <Shell
      leagues={leagues}
      currentLeagueId={id}
      activeNav={navKey}
      alertCount={data?.summary?.needsAttention || 0}
      rail={data?.ok ? <RailSummary data={data} /> : null}
    >
      {loading && <Skeleton count={6} height={64} />}

      {!loading && data && !data.ok && <Broken data={data} />}

      {!loading && data?.ok && (
        <>
          <Freshness at={data.syncedAt} onRefresh={() => load(true)} busy={busy} />

          <div className="chips" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={active === t.key}
                className="chip"
                data-on={active === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {active === "lineup" && <LineupTab data={data} pos={pos} setPos={setPos} />}
          {active === "moves" && <MovesTab data={data} />}
          {active === "waivers" && <WaiversTab data={data} pos={pos} setPos={setPos} />}
          {active === "opponent" && <OpponentTab data={data} />}
          {active === "league" && <LeagueTab data={data} />}
        </>
      )}
    </Shell>
  );
}

/* ---------------- tabs ---------------- */

function LineupTab({ data, pos, setPos }) {
  const { lineup, myTeam } = data;
  const starters = lineup.current.starters;
  const bench = myTeam.roster.filter((p) => !p.isStarter);
  const keep = (list) => list.filter((p) => pos === "ALL" || p.position === pos);

  return (
    <>
      <div className="card" style={{ padding: 13, marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 20 }}>
          <div>
            <div className="num" style={{ fontSize: 27 }}>{lineup.current.projectedPoints}</div>
            <div className="pmeta">Current lineup</div>
          </div>
          <div>
            <div className="num" style={{ fontSize: 27, color: "var(--accent)" }}>
              {lineup.optimal.projectedPoints}
            </div>
            <div className="pmeta">Optimal lineup</div>
          </div>
          {lineup.gain > 0 && (
            <div style={{ marginLeft: "auto", textAlign: "right" }}>
              <div className="num" style={{ fontSize: 27, color: "var(--accent)" }}>+{lineup.gain}</div>
              <div className="pmeta">Available</div>
            </div>
          )}
        </div>
      </div>

      {data.benchPoints?.weeks?.length > 0 && <BenchPoints bench={data.benchPoints} />}

      <PosFilter pos={pos} setPos={setPos} />

      <div className="h">Starting</div>
      <PlayerList players={keep(starters)} showSlot />

      <div className="h">Bench</div>
      <PlayerList players={keep(bench)} />
    </>
  );
}

function MovesTab({ data }) {
  const recs = data.recommendations || [];
  if (!recs.length) {
    return (
      <div className="card">
        <Empty glyph="✓">
          Your lineup already matches the optimal one and nothing needs a decision.
        </Empty>
      </div>
    );
  }
  return (
    <>
      <div className="h">{recs.length} recommendation{recs.length === 1 ? "" : "s"}</div>
      {recs.map((r) => <RecommendationCard key={r.id} rec={r} showLeague={false} />)}
    </>
  );
}

function WaiversTab({ data, pos, setPos }) {
  const [bucket, setBucket] = useState("best");

  if (!data.waiverSupported) {
    return (
      <div className="note">
        <b>Waiver data isn't available for this league.</b>
        <p style={{ margin: "6px 0 0" }}>{data.waiverUnsupportedReason}</p>
      </div>
    );
  }

  const buckets = {
    best: data.waivers,
    immediate: data.waivers.filter((p) => p.bestUse?.startsWith("Immediate")),
    upside: [...data.waivers].sort((a, b) => (b.projection?.ceiling || 0) - (a.projection?.ceiling || 0)),
    floor: [...data.waivers].sort((a, b) => (b.projection?.floor || 0) - (a.projection?.floor || 0)),
  };

  const list = (buckets[bucket] || []).filter((p) => pos === "ALL" || p.position === pos).slice(0, 30);

  return (
    <>
      <div className="chips">
        {[
          ["best", "Best available"],
          ["immediate", "Immediate help"],
          ["upside", "Upside"],
          ["floor", "Safe floor"],
        ].map(([k, label]) => (
          <button key={k} className="chip" data-on={bucket === k} onClick={() => setBucket(k)}>
            {label}
          </button>
        ))}
      </div>

      <PosFilter pos={pos} setPos={setPos} />

      {list.length === 0 ? (
        <div className="card">
          <Empty glyph="○">
            {pos === "ALL"
              ? "Your roster doesn't have an obvious upgrade available right now."
              : `Nothing worth adding at ${pos}.`}
          </Empty>
        </div>
      ) : (
        list.map((p) => <WaiverCard key={p.canonicalId} p={p} />)
      )}
    </>
  );
}

function OpponentTab({ data }) {
  const s = data.scouting;
  if (!s) {
    return <div className="card"><Empty glyph="○">No matchup this week.</Empty></div>;
  }
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="matchrow">
          <div>
            <div className="who">{data.myTeam.teamName}</div>
            <div className="num sc">{s.myProjected}</div>
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)" }}>vs</div>
          <div className="right">
            <div className="who">{data.oppTeam?.teamName || data.matchup?.oppName}</div>
            <div className="num sc">{s.oppProjected}</div>
          </div>
        </div>
        {s.winProbability != null && (
          <div style={{ padding: "0 12px 12px" }} className="wp">
            {s.winProbability}% win probability, simulated from each roster's own weekly variance
          </div>
        )}
      </div>

      <div className="h">Position by position</div>
      <div className="list">
        {Object.entries(s.byPosition).map(([p, v]) => (
          <div className="row" key={p}>
            <span className={`pos ${p}`}>{p}</span>
            <span className="pmain">
              <span className="pmeta">{v.mine} vs {v.theirs}</span>
            </span>
            <span className="pstat">
              <span
                className="num big"
                style={{ color: v.edge > 0 ? "var(--accent)" : v.edge < 0 ? "var(--critical)" : undefined }}
              >
                {v.edge > 0 ? "+" : ""}{v.edge}
              </span>
            </span>
          </div>
        ))}
      </div>

      {s.edges.length > 0 && (
        <>
          <div className="h">Where you have an edge</div>
          <div className="note">
            {s.edges.map((e) => `${e.position} by ${e.points.toFixed(1)} points`).join(", ")}.
          </div>
        </>
      )}
      {s.vulnerabilities.length > 0 && (
        <>
          <div className="h">Where you're vulnerable</div>
          <div className="note">
            {s.vulnerabilities.map((e) => `${e.position} by ${e.points.toFixed(1)} points`).join(", ")}.
          </div>
        </>
      )}
    </>
  );
}

function LeagueTab({ data }) {
  return (
    <>
      <div className="h">Power rankings by roster strength</div>
      <div className="list">
        {data.powerRankings.map((t, i) => (
          <div className="row" key={t.teamId}>
            <span className="slot num">{i + 1}</span>
            <span className="pmain">
              <span className="pname">{t.teamName}</span>
              <span className="pmeta">
                {t.record} · {t.pointsFor} PF · bench {t.benchStrength}
              </span>
            </span>
            <span className="pstat">
              <span className="num big">{t.rosterStrength}</span>
              <span className="sub">roster</span>
            </span>
          </div>
        ))}
      </div>

      <div className="h">Your roster health</div>
      <div className="list">
        {Object.entries(data.health.byPosition).map(([p, v]) => (
          <div className="row" key={p}>
            <span className={`pos ${p}`}>{p}</span>
            <span className="pmain">
              <span className="pname">Starter: {v.starter} · Depth: {v.depth}</span>
              <span className="pmeta">
                {v.count} rostered · league median {v.leagueMedian}
              </span>
            </span>
          </div>
        ))}
      </div>

      {data.health.needs.length > 0 && (
        <>
          <div className="h">Biggest needs</div>
          <div className="note">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {data.health.needs.slice(0, 4).map((n, i) => <li key={i}>{n.issue}</li>)}
            </ol>
          </div>
        </>
      )}

      {data.trades?.length > 0 && (
        <>
          <div className="h">Possible trades — both sides improve</div>
          {data.trades.slice(0, 5).map((t, i) => (
            <div className="card" key={i} style={{ padding: 12, marginBottom: 9 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Give {t.give.name} ({t.give.position}) → get {t.receive.name} ({t.receive.position})
              </div>
              <div className="pmeta" style={{ marginTop: 4 }}>
                with {t.team} · you +{t.myGain}, them +{t.theirGain} projected pts/week
              </div>
              <div className="pmeta" style={{ marginTop: 5, color: "var(--dim)" }}>
                Suggestion only — nothing is submitted to your league.
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/* ---------------- pieces ---------------- */

function BenchPoints({ bench }) {
  const max = Math.max(...bench.weeks.map((w) => w.optimal), 1);
  return (
    <div className="card" style={{ padding: 13, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="num" style={{ fontSize: 24, color: "var(--high)" }}>{bench.totalLeft}</span>
        <span className="pmeta">points left on your bench this season</span>
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 54, marginTop: 11 }}>
        {bench.weeks.map((w) => (
          <div key={w.week} style={{ flex: 1, textAlign: "center" }} title={`Week ${w.week}: ${w.actual} actual, ${w.optimal} optimal`}>
            <div style={{ height: 40, display: "flex", alignItems: "flex-end" }}>
              <div style={{ width: "100%", background: "var(--raised)", height: `${(w.optimal / max) * 100}%`, borderRadius: "2px 2px 0 0", position: "relative" }}>
                <div style={{ position: "absolute", bottom: 0, width: "100%", background: "var(--accent)", height: `${(w.actual / Math.max(w.optimal, 1)) * 100}%`, borderRadius: "2px 2px 0 0" }} />
              </div>
            </div>
            <div style={{ fontSize: 9, color: "var(--dim)", marginTop: 3 }}>{w.week}</div>
          </div>
        ))}
      </div>
      <div className="pmeta" style={{ marginTop: 6, fontSize: 11 }}>
        Green is what you started; grey is what the optimal lineup would have scored.
      </div>
    </div>
  );
}

function WaiverCard({ p }) {
  return (
    <div className="card" style={{ padding: 12, marginBottom: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span className={`pos ${p.position}`}>{p.position}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14.5 }}>{p.name}</span>
        <span className="num" style={{ fontSize: 20, color: p.upgrade > 0 ? "var(--accent)" : "var(--dim)" }}>
          {p.upgrade > 0 ? "+" : ""}{p.upgrade}
        </span>
      </div>
      <div className="pmeta" style={{ marginTop: 6 }}>
        <span>{p.proTeam || "FA"}</span>
        <span className="tag src">{p.projection?.sourceLabel || "No projection"}</span>
        {p.projection?.points != null && <span>{p.projection.points} projected</span>}
        {p.projection?.floor != null && (
          <span>{p.projection.floor}–{p.projection.ceiling} range</span>
        )}
      </div>
      <div style={{ fontSize: 12.5, marginTop: 7 }}>
        <div><strong>Best use:</strong> {p.bestUse}</div>
        {p.dropCandidate && (
          <div style={{ color: "var(--muted)" }}>
            Drop candidate: {p.dropCandidate.name} ({p.replacementLevel} projected)
          </div>
        )}
        {p.reasonsAgainst?.length > 0 && (
          <div style={{ color: "var(--muted)", marginTop: 3 }}>
            Against: {p.reasonsAgainst.join("; ")}
          </div>
        )}
      </div>
    </div>
  );
}

function PosFilter({ pos, setPos }) {
  return (
    <div className="chips" aria-label="Filter by position">
      {POSITIONS.map((p) => (
        <button key={p} className="chip" data-on={pos === p} aria-pressed={pos === p} onClick={() => setPos(p)}>
          {p === "ALL" ? "All" : p}
        </button>
      ))}
    </div>
  );
}

function PlayerList({ players, showSlot }) {
  if (!players?.length) {
    return <div className="card"><Empty glyph="○">No players here.</Empty></div>;
  }
  return (
    <div className="list">
      {players.map((p) => (
        <div className="row" key={p.canonicalId}>
          {showSlot && <span className="slot">{p.slot}</span>}
          <span className={`pos ${p.position}`}>{p.position}</span>
          <span className="pmain">
            <span className="pname">{p.name}</span>
            <span className="pmeta">
              <span>{p.proTeam || "FA"}</span>
              {p.status === "OUT" || p.status === "IR" ? (
                <span className="tag out">{p.status}</span>
              ) : p.status === "QUESTIONABLE" ? (
                <span className="tag q">Q</span>
              ) : null}
              {p.projection?.floor != null && (
                <span>{p.projection.floor}–{p.projection.ceiling}</span>
              )}
            </span>
          </span>
          <span className="pstat">
            <span className={`num big${p.projection?.points == null ? " nodata" : ""}`}>
              {p.projection?.points ?? "—"}
            </span>
            <span className="sub">{p.projection?.sourceLabel || "no data"}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function RailSummary({ data }) {
  return (
    <>
      <div className="h rail-title">Needs attention</div>
      {(data.recommendations || []).slice(0, 4).map((r) => (
        <RecommendationCard key={r.id} rec={r} showLeague={false} />
      ))}
      {(!data.recommendations || data.recommendations.length === 0) && (
        <div className="card"><Empty glyph="✓">Nothing urgent.</Empty></div>
      )}
    </>
  );
}

function Broken({ data }) {
  return (
    <div className="note bad">
      <b>This league isn't syncing.</b>
      <p style={{ margin: "6px 0 0" }}>{data.error}</p>
      {data.causes?.length > 0 && (
        <ul>{data.causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
      )}
      {data.choices && (
        <>
          <p style={{ margin: "8px 0 0", color: "var(--text)" }}>Teams in this league:</p>
          <ul>{data.choices.map((c) => <li key={c.id}><code>{c.id}</code> — {c.name}</li>)}</ul>
        </>
      )}
      <a className="minibtn" href="/api/diagnose" style={{ marginTop: 10, display: "inline-block" }}>
        Check connection
      </a>
    </div>
  );
}
