import { useState } from "react";
import Link from "next/link";

const GLYPH = { CRITICAL: "●", HIGH: "▲", MEDIUM: "◆", LOW: "■" };
const LABEL = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Info" };

/**
 * One recommendation. Structure is fixed so scanning a stack of these is
 * fast: severity, where it came from, what to do, why, how much, how sure.
 * Severity is carried by an icon and a word as well as colour.
 */
export default function RecommendationCard({ rec, showLeague = true }) {
  const [open, setOpen] = useState(false);
  const impact = rec.impact?.points;
  const negative = impact != null && impact < 0;

  return (
    <article className="rec" data-sev={rec.severity}>
      <div className="rec-head">
        <span className="sevchip" data-sev={rec.severity}>
          <span aria-hidden="true">{GLYPH[rec.severity]}</span>
          {LABEL[rec.severity]}
        </span>
        {showLeague && (
          <span className="rec-origin">
            {rec.leagueName} · {rec.teamName}
          </span>
        )}
      </div>

      <div className="rec-body">
        <h3 className="rec-action">{rec.action}</h3>
        <p className="rec-reason">{rec.reason}</p>

        <div className="rec-foot">
          {impact != null && (
            <>
              <span className={`num impact${negative ? " negative" : ""}`}>
                {impact > 0 ? "+" : ""}{impact.toFixed(1)}
              </span>
              <span className="impact-unit">{rec.impact.unit}</span>
            </>
          )}
          {rec.confidence && (
            <span className="conf">
              Confidence: {rec.confidence.level === "UNAVAILABLE"
                ? "unavailable"
                : `${rec.confidence.level.toLowerCase()}${rec.confidence.score != null ? ` (${rec.confidence.score}%)` : ""}`}
            </span>
          )}
        </div>

        <div className="rec-actions">
          <Link href={rec.link} className="minibtn primary">Investigate</Link>
          {rec.why?.length > 0 && (
            <button
              className="minibtn"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? "Hide detail" : "Why?"}
            </button>
          )}
        </div>
      </div>

      {open && rec.why?.length > 0 && (
        <div className="why">
          {rec.why.map((w, i) => (
            <div className="why-row" key={i}>
              <span className="lbl">{w.label}</span>
              <span className="val">{w.value}</span>
            </div>
          ))}
          <div className="why-row" style={{ marginTop: 6, opacity: 0.7 }}>
            <span className="lbl">Generated</span>
            <span className="val">{new Date(rec.createdAt).toLocaleTimeString()}</span>
          </div>
        </div>
      )}
    </article>
  );
}
