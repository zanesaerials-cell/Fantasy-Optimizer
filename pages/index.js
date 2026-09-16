import { useEffect, useState } from "react";

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/report")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={styles.page}>
      <h1 style={styles.h1}>Weekly Fantasy Report</h1>

      {loading && <p>Loading your leagues…</p>}
      {error && <p style={styles.error}>Error: {error}</p>}

      {data && (
        <>
          <Section title="ESPN — TexArkana Football League">
            <EspnReport report={data.espn} />
          </Section>
          <Section title="Sleeper League">
            <SleeperReport report={data.sleeper} />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </div>
  );
}

function EspnReport({ report }) {
  if (!report?.configured) {
    return <p style={styles.warn}>Not configured: {report?.reason}</p>;
  }
  if (!report.myTeam) {
    return <p style={styles.warn}>Set ESPN_TEAM_ID in your env vars to identify your team. Teams in this league: {report.allTeams.map((t) => t.teamName).join(", ")}</p>;
  }
  return (
    <>
      <h3 style={styles.h3}>{report.myTeam.teamName}</h3>
      <PlayerTable players={report.myTeam.players} />

      {report.lineupRecommendations.length > 0 && (
        <>
          <h4 style={styles.h4}>Suggested Moves</h4>
          <ul>
            {report.lineupRecommendations.map((r, i) => (
              <li key={i} style={r.type === "injury_flag" ? styles.recWarn : styles.rec}>
                {r.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {report.topFreeAgents?.length > 0 && (
        <>
          <h4 style={styles.h4}>Top Available Free Agents</h4>
          <ul>
            {report.topFreeAgents.slice(0, 10).map((p, i) => (
              <li key={i}>
                {p.name} ({p.position}) — {p.percentOwned.toFixed(0)}% owned
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SleeperReport({ report }) {
  if (!report?.configured) {
    return <p style={styles.warn}>Not configured: {report?.reason}</p>;
  }
  if (!report.myRoster) {
    return (
      <p style={styles.warn}>
        Set SLEEPER_USERNAME in your env vars to identify your team. Teams in this league:{" "}
        {report.allRosters.map((r) => r.ownerName).join(", ")}
      </p>
    );
  }
  return (
    <>
      <h3 style={styles.h3}>
        {report.myRoster.ownerName} ({report.myRoster.record})
      </h3>
      <h4 style={styles.h4}>Starters</h4>
      <PlayerTable players={report.myRoster.starters} sleeper />
      <h4 style={styles.h4}>Bench</h4>
      <PlayerTable players={report.myRoster.bench} sleeper />

      {report.waiverSuggestions?.length > 0 && (
        <>
          <h4 style={styles.h4}>Trending Waiver Adds (unrostered in your league)</h4>
          <ul>
            {report.waiverSuggestions.map((p, i) => (
              <li key={i}>
                {p.name} ({p.position}, {p.team}) — added by {p.addCount24h} managers in last 24h
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function PlayerTable({ players, sleeper }) {
  if (!players?.length) return <p>—</p>;
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Player</th>
          <th style={styles.th}>Pos</th>
          {!sleeper && <th style={styles.th}>Avg Pts</th>}
          <th style={styles.th}>Status</th>
        </tr>
      </thead>
      <tbody>
        {players.map((p, i) => (
          <tr key={i}>
            <td style={styles.td}>{p.name}</td>
            <td style={styles.td}>{p.position}</td>
            {!sleeper && <td style={styles.td}>{p.avgPoints?.toFixed?.(1) ?? "-"}</td>}
            <td style={styles.td}>{p.injuryStatus}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const styles = {
  page: { fontFamily: "system-ui, sans-serif", maxWidth: 800, margin: "0 auto", padding: 24 },
  h1: { fontSize: 24, marginBottom: 16 },
  h2: { fontSize: 20, borderBottom: "1px solid #ddd", paddingBottom: 6, marginTop: 32 },
  h3: { fontSize: 17, marginTop: 16 },
  h4: { fontSize: 15, marginTop: 20, color: "#444" },
  section: { marginBottom: 32 },
  warn: { color: "#b45309", background: "#fffbeb", padding: 12, borderRadius: 6 },
  error: { color: "#b91c1c" },
  rec: { color: "#065f46" },
  recWarn: { color: "#b91c1c" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 14 },
  th: { textAlign: "left", borderBottom: "2px solid #eee", padding: "4px 8px" },
  td: { borderBottom: "1px solid #f2f2f2", padding: "4px 8px" },
};
