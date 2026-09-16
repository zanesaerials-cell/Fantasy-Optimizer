import { useState } from "react";
import { useRouter } from "next/router";

const NAV = [
  { key: "home", label: "Home", glyph: "◈", href: "/" },
  { key: "lineup", label: "Lineup", glyph: "▤", tab: "lineup" },
  { key: "moves", label: "Moves", glyph: "⇄", tab: "moves" },
  { key: "waivers", label: "Waivers", glyph: "+", tab: "waivers" },
  { key: "league", label: "League", glyph: "◎", tab: "league" },
];

export function Shell({ children, rail, leagues = [], currentLeagueId, activeNav = "home", alertCount = 0 }) {
  const [sheet, setSheet] = useState(false);
  const router = useRouter();

  const current = leagues.find((l) => l.id === currentLeagueId);
  const grouped = leagues.reduce((acc, l) => {
    (acc[l.platform] = acc[l.platform] || []).push(l);
    return acc;
  }, {});

  const go = (item) => {
    if (item.href) return router.push(item.href);
    const target = currentLeagueId || leagues.find((l) => l.ok !== false)?.id;
    if (!target) return router.push("/");
    router.push(`/league/${target}?tab=${item.tab}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div style={{ minWidth: 0 }}>
            <div className="greeting">{greeting()}</div>
            <div className="brandline">
              {current ? current.name : "All leagues"}
            </div>
          </div>

          {leagues.length > 0 && (
            <button
              className="switcher"
              onClick={() => setSheet(true)}
              aria-haspopup="dialog"
            >
              <span>{current ? current.teamName || current.name : "All leagues"}</span>
              <span aria-hidden="true">▾</span>
            </button>
          )}
        </div>
      </header>

      <div className="shell3">
        <nav className="sidenav" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.key}
              data-on={activeNav === item.key}
              onClick={() => go(item)}
            >
              <span className="glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <main className="main">{children}</main>

        <aside className="rail">{rail}</aside>
      </div>

      <nav className="bottomnav" aria-label="Sections">
        {NAV.map((item) => (
          <button
            key={item.key}
            data-on={activeNav === item.key}
            onClick={() => go(item)}
            aria-current={activeNav === item.key ? "page" : undefined}
          >
            <span className="glyph" aria-hidden="true">{item.glyph}</span>
            {item.label}
            {item.key === "home" && alertCount > 0 && (
              <span className="navdot">{alertCount > 9 ? "9+" : alertCount}</span>
            )}
          </button>
        ))}
      </nav>

      {sheet && (
        <div
          className="sheet-backdrop"
          role="dialog"
          aria-label="Choose a league"
          onClick={() => setSheet(false)}
        >
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <button
              className="sheet-item"
              data-on={!currentLeagueId}
              onClick={() => { setSheet(false); router.push("/"); }}
            >
              <span className="nm"><b>All leagues</b><small>Command center</small></span>
            </button>

            {Object.entries(grouped).map(([platform, list]) => (
              <div key={platform}>
                <div className="sheet-group">{platform.toUpperCase()}</div>
                {list.map((l) => (
                  <button
                    key={l.id}
                    className="sheet-item"
                    data-on={l.id === currentLeagueId}
                    onClick={() => { setSheet(false); router.push(`/league/${l.id}`); }}
                  >
                    <span className="nm">
                      <b>{l.name}</b>
                      <small>
                        {l.ok === false
                          ? "Needs attention"
                          : [l.teamName, l.record].filter(Boolean).join(" · ")}
                      </small>
                    </span>
                    {l.alerts?.needsAttention > 0 && (
                      <span className="sevchip" data-sev="HIGH">{l.alerts.needsAttention}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Freshness({ at, onRefresh, busy }) {
  return (
    <div className="freshness">
      <span>{at ? `Updated ${relative(at)}` : "Not yet loaded"}</span>
      <button onClick={onRefresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

export function Empty({ glyph = "○", children }) {
  return (
    <div className="empty">
      <span className="glyph" aria-hidden="true">{glyph}</span>
      {children}
    </div>
  );
}

export function Skeleton({ height = 76, count = 4 }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skel" key={i} style={{ height, marginBottom: 9 }} />
      ))}
    </div>
  );
}

export function relative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.floor(hrs / 24)} day(s) ago`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
