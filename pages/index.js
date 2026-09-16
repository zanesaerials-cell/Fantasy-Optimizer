import { useEffect, useMemo, useState, useCallback } from "react";

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DEF"];
const FLEX_SET = ["RB", "WR", "TE"];

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState("espn");
  const [tab, setTab] = useState("lineup");
  const [pos, setPos] = useState("ALL");
  const [market, setMarket] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/report")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const league = data?.[platform];

  // Market projections are fetched lazily — each Odds API call costs credits.
  useEffect(() => {
    if (!league?.configured || !data?.oddsAvailable || market) return;
    const names = collectNames(league);
    if (!names.length) return;
    const qs = new URLSearchParams({
      players: names.join("|"),
      scoring: JSON.stringify(league.scoring || {}),
    });
    fetch(`/api/odds?${qs}`)
      .then((r) => r.json())
      .then((d) => setMarket(d.projections || {}))
      .catch(() => setMarket({}));
  }, [league, data, market]);

  const withMarket = useCallback(
    (p) => (p?.name && market?.[p.name] ? { ...p, market: market[p.name] } : p),
    [market]
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brandrow">
          <span className="brand">
            {league?.leagueName || "Lineup"}
          </span>
          {data && (
            <span className="weekpill">
              Week {data.week} · {data.season}
            </span>
          )}
        </div>
        <nav className="seg">
          <button data-on={platform === "espn"} onClick={() => { setPlatform("espn"); setMarket(null); }}>
            ESPN
          </button>
          <button data-on={platform === "sleeper"} onClick={() => { setPlatform("sleeper"); setMarket(null); }}>
            Sleeper
          </button>
        </nav>
        <nav className="seg">
          {["lineup", "moves", "waivers", "league"].map((t) => (
            <button key={t} data-on={tab === t} onClick={() => setTab(t)}>
              {{ lineup: "Lineup", moves: "Moves", waivers: "Waivers", league: "League" }[t]}
            </button>
          ))}
        </nav>
      </header>

      {loading && <Skeletons />}
      {error && <p className="note bad">Couldn't load your leagues. {error}</p>}

      {!loading && league && !league.configured && (
        <p className="note bad">{league.error}</p>
      )}

      {!loading && league?.needsTeamId && (
        <div className="note">
          Add <code>ESPN_TEAM_ID</code> in Vercel, then redeploy. Teams in this league:
          <ul>
            {league.teams.map((t) => (
              <li key={t.teamId}>
                <code>{t.teamId}</code> — {t.teamName}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && league?.needsUsername && (
        <div className="note">
          Add <code>SLEEPER_USERNAME</code> in Vercel. Managers: {league.teams.join(", ")}
        </div>
      )}

      {!loading && league?.configured && league.myTeam && (
        <>
          {tab === "lineup" && (
            <LineupTab league={league} pos={pos} setPos={setPos} withMarket={withMarket} />
          )}
          {tab === "moves" && <MovesTab league={league} />}
          {tab === "waivers" && (
            <WaiversTab league={league} platform={platform} pos={pos} setPos={setPos} withMarket={withMarket} />
          )}
          {tab === "league" && <LeagueTab league={league} />}
        </>
      )}

      {!loading && (
        <button className="btn ghost" style={{ marginTop: 20 }} onClick={load}>
          Refresh data
        </button>
      )}
    </div>
  );
}

/* ---------------- tabs ---------------- */

function LineupTab({ league, pos, setPos, withMarket }) {
  const starters = league.myTeam.starters || league.myTeam.players?.filter((p) => p.isStarter) || [];
  const bench = league.myTeam.players?.filter(
    (p) => !starters.some((s) => s.playerId === p.playerId)
  ) || [];

  const shown = (list) => list.filter((p) => matchesPos(p, pos)).map(withMarket);
  const optimalTotal = league.optimal?.projectedTotal ?? 0;
  const currentTotal = league.myTeam.currentProjected ?? 0;
  const delta = Number((optimalTotal - currentTotal).toFixed(1));

  return (
    <>
      {league.matchup && (
        <div className="score">
          <div className="side">
            <div className="who">{league.myTeam.teamName || "My team"}</div>
            <div className="num pts">{fmt(league.matchup.myScore)}</div>
            <div className="proj">{currentTotal.toFixed(1)} projected</div>
          </div>
          <div className="vs">vs</div>
          <div className="side right">
            <div className="who">{league.matchup.oppName}</div>
            <div className="num pts">{fmt(league.matchup.oppScore)}</div>
          </div>
        </div>
      )}

      <PosFilter pos={pos} setPos={setPos} />

      <div className="h">Starting lineup</div>
      <PlayerList players={shown(starters)} showSlot />

      {delta > 0.5 && (
        <div className="totals">
          <span className="lbl">Optimal lineup would score</span>
          <span className="num val up">+{delta.toFixed(1)}</span>
        </div>
      )}

      <div className="h">Bench</div>
      <PlayerList players={shown(bench)} />
    </>
  );
}

function MovesTab({ league }) {
  const recs = league.recommendations || [];
  if (!recs.length)
    return (
      <p className="note">
        Your lineup already matches the optimal one for this week. Check back after
        injury reports drop on Friday.
      </p>
    );
  return (
    <>
      <div className="h">{recs.length} suggested {recs.length === 1 ? "change" : "changes"}</div>
      {recs.map((r, i) => (
        <div className="rec" data-p={r.priority} key={i}>
          <div className="body">
            <div className="headline">{r.message}</div>
            <div className="detail">{r.detail}</div>
          </div>
          {r.gain > 0 && <div className="num gain">+{r.gain.toFixed(1)}</div>}
        </div>
      ))}
    </>
  );
}

function WaiversTab({ league, platform, pos, setPos, withMarket }) {
  const raw = platform === "espn" ? league.freeAgents : league.waiverTargets;
  const list = (raw || []).filter((p) => matchesPos(p, pos)).map(withMarket).slice(0, 40);

  return (
    <>
      <PosFilter pos={pos} setPos={setPos} />
      <div className="h">
        Best available{pos !== "ALL" ? ` · ${pos}` : ""} — ranked by upgrade over your roster
      </div>
      {list.length ? (
        <PlayerList players={list} showUpgrade />
      ) : (
        <p className="note">Nothing available at {pos} right now.</p>
      )}
    </>
  );
}

function LeagueTab({ league }) {
  return (
    <>
      <div className="h">Standings by points scored</div>
      <div className="list">
        {(league.standings || []).map((t, i) => (
          <div className="row" key={i}>
            <div className="slot num">{i + 1}</div>
            <div className="pmain">
              <div className="pname">{t.teamName}</div>
              <div className="pmeta">{t.record}</div>
            </div>
            <div className="pstat">
              <div className="num big">{fmt(t.pointsFor)}</div>
              <div className="sub">points</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- pieces ---------------- */

function PosFilter({ pos, setPos }) {
  return (
    <>
      <div className="chips" role="tablist" aria-label="Filter by position">
        {POSITIONS.map((p) => (
          <button
            key={p}
            className="chip"
            data-on={pos === p}
            aria-pressed={pos === p}
            onClick={() => setPos(p)}
          >
            {p === "ALL" ? "All" : p}
          </button>
        ))}
      </div>
      <select
        className="select"
        value={pos}
        onChange={(e) => setPos(e.target.value)}
        aria-label="Filter by position"
        style={{ display: "none" }}
      >
        {POSITIONS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
    </>
  );
}

function PlayerList({ players, showSlot, showUpgrade }) {
  if (!players?.length) return <p className="note">No players to show.</p>;
  return (
    <div className="list">
      {players.map((p, i) => (
        <PlayerRow key={p.playerId || i} p={p} showSlot={showSlot} showUpgrade={showUpgrade} />
      ))}
    </div>
  );
}

function PlayerRow({ p, showSlot, showUpgrade }) {
  const injured = isOut(p.injuryStatus);
  const questionable = String(p.injuryStatus || "").toUpperCase() === "QUESTIONABLE";

  // Priority: live market number, then platform projection, then season avg.
  const primary =
    p.market?.points ?? p.weekProjected ?? p.weekActual ?? p.seasonAvg ?? null;
  const label = p.market
    ? "market proj"
    : p.weekProjected != null
    ? "projected"
    : p.weekActual != null
    ? "this week"
    : p.seasonAvg != null
    ? "season avg"
    : "no data";

  return (
    <div className="row">
      {showSlot && <div className="slot">{p.lineupSlot || p.slot || ""}</div>}
      <div className={`pos ${(p.position || "").replace("/", "")}`}>{p.position}</div>
      <div className="pmain">
        <div className="pname">{p.name}</div>
        <div className="pmeta">
          <span>{p.proTeam || "FA"}</span>
          {injured && <span className="tag out">{p.injuryStatus}</span>}
          {questionable && <span className="tag q">Q</span>}
          {p.market && <span className="tag mkt">{p.market.tdProbability ?? "—"}% TD</span>}
          {p.seasonTotal != null && <span>{fmt(p.seasonTotal)} season</span>}
          {showUpgrade && p.upgrade != null && (
            <span className={p.upgrade > 0 ? "up" : ""}>
              {p.upgrade > 0 ? "+" : ""}{p.upgrade.toFixed(1)} vs your worst
            </span>
          )}
        </div>
      </div>
      <div className="pstat">
        <div className={`num big ${primary == null ? "nodata" : ""}`}>
          {primary == null ? "—" : fmt(primary)}
        </div>
        <div className="sub">{label}</div>
      </div>
    </div>
  );
}

function Skeletons() {
  return (
    <div>
      {Array.from({ length: 7 }).map((_, i) => (
        <div className="skel" key={i} />
      ))}
    </div>
  );
}

/* ---------------- helpers ---------------- */

function matchesPos(p, pos) {
  if (pos === "ALL") return true;
  if (pos === "FLEX") return FLEX_SET.includes(p.position);
  return p.position === pos;
}

function isOut(s) {
  return ["OUT", "IR", "DOUBTFUL", "SUSPENSION", "PUP", "NA"].includes(
    String(s || "").toUpperCase()
  );
}

function fmt(n) {
  if (n == null) return "—";
  return Number(n).toFixed(1);
}

function collectNames(league) {
  const set = new Set();
  const add = (arr) => (arr || []).forEach((p) => p?.name && set.add(p.name));
  add(league.myTeam?.players);
  add(league.myTeam?.starters);
  add(league.freeAgents);
  add(league.waiverTargets);
  return [...set].slice(0, 300);
}
