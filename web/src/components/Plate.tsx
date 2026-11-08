import { useEffect, useState } from "react";
import { seconds, usd } from "../format";
import type { ReviewState } from "../review-state";
import { ErrorPanel } from "./ErrorPanel";
import { Spectrum } from "./Spectrum";

interface PlateProps {
  state: ReviewState;
  letters: Map<string, string>;
  isSample: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onUseOwnKey: () => void;
}

function useElapsed(running: boolean, startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);
  return running ? Math.max(0, now - startedAt) : 0;
}

interface Verdict {
  figure: string;
  caption: string;
}

function verdictFor(state: ReviewState, elapsed: number): Verdict {
  const c = state.candidates;
  if (state.phase === "running") {
    if (!c) return { figure: seconds(elapsed), caption: "Pass 1 is reading the diff and the files around it" };
    if (c.length === 0) return { figure: "0", caption: "candidates raised. Finishing up" };
    const done = c.filter((x) => x.status !== "pending").length;
    return { figure: `${done}/${c.length}`, caption: "verdicts in. Pass 2 is trying to refute each candidate" };
  }
  if (state.result) {
    const s = state.result.stats;
    if (s.candidates === 0) return { figure: "0", caption: "candidates. Nothing worth saying" };
    return {
      figure: `${s.survived} of ${s.candidates}`,
      caption: s.survived === 1 ? "candidate survived refutation" : "candidates survived refutation",
    };
  }
  return { figure: "", caption: "" };
}

interface Stat {
  label: string;
  value: string;
  tone?: "accent";
}

function statsFor(state: ReviewState, elapsed: number): Stat[] {
  const c = state.candidates ?? [];
  const refuted = c.filter((x) => x.status === "refuted").length;
  const survived = c.filter((x) => x.status === "survived").length;
  const r = state.result;
  return [
    { label: "Candidates", value: state.candidates ? String(c.length) : "–" },
    { label: "Refuted", value: state.candidates ? String(refuted) : "–" },
    { label: "Survived", value: state.candidates ? String(survived) : "–", tone: "accent" },
    r
      ? { label: state.cached ? "Cost (cached)" : "Cost", value: usd(r.usage.cost) }
      : { label: "Elapsed", value: state.phase === "running" ? seconds(elapsed) : "–" },
  ];
}

interface Row {
  key: string;
  label: string;
  at: string;
}

/**
 * A cached review has no live stream to log, so replay what the recorded run
 * did from its result instead of showing an empty card.
 */
function recordedRows(state: ReviewState): Row[] | null {
  const r = state.result;
  if (!state.cached || !r) return null;
  const s = r.stats;
  const skipped = r.skipped.length ? `, ${r.skipped.length} skipped` : "";
  return [
    { key: "pr", label: `Fetched PR at ${r.pr.headSha.slice(0, 7)}`, at: "" },
    { key: "files", label: `${s.filesReviewed} ${s.filesReviewed === 1 ? "file" : "files"} reviewed${skipped}`, at: "" },
    { key: "candidates", label: `Pass 1 raised ${s.candidates} ${s.candidates === 1 ? "candidate" : "candidates"}`, at: "" },
    { key: "verifying", label: `Pass 2 refuted ${s.refuted}, ${s.survived} survived`, at: "" },
    { key: "done", label: "Recorded run, replayed from cache", at: seconds(s.durationMs) },
  ];
}

function refOf(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
  return m ? `${m[1]}/${m[2]} #${m[3]}` : url;
}

export function Plate({ state, letters, isSample, onSelect, onRetry, onUseOwnKey }: PlateProps) {
  const running = state.phase === "running";
  const elapsed = useElapsed(running, state.startedAt);
  const verdict = verdictFor(state, elapsed);
  const scanning = running && state.candidates === null;
  const failed = state.phase === "error" && state.error !== null;
  const title = state.pr ? state.pr.title : running ? "Fetching the pull request" : "Not reviewed";

  if (state.phase === "idle") {
    return (
      <div className="bento" data-reveal>
        <section className="card plate plate-idle" aria-label="Review">
          <Spectrum candidates={null} letters={letters} scanning={false} />
          <p className="plate-hint">Paste a pull request or open a sample. Its candidates appear here as lines.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="bento" data-reveal>
      <section className="card plate" aria-label="Review" aria-busy={running}>
        <header className="plate-pr">
          <p className="plate-ref mono">
            {isSample && <span className="tag">Sample</span>}
            {state.cached && !isSample && <span className="tag">Cached</span>}
            {refOf(state.url)}
            {state.pr && <span className="plate-sha">@{state.pr.headSha.slice(0, 7)}</span>}
          </p>
          <p className="plate-title">{title}</p>
        </header>

        {failed && state.error ? (
          <ErrorPanel error={state.error} onRetry={onRetry} onUseOwnKey={onUseOwnKey} />
        ) : (
          <>
            <Spectrum candidates={state.candidates} letters={letters} scanning={scanning} onSelect={onSelect} />
            <p className="verdict" aria-live="polite">
              <span className="verdict-figure">{verdict.figure}</span>
              <span className="verdict-caption">{verdict.caption}</span>
            </p>
          </>
        )}
      </section>

      <section className="card timeline-card" aria-label="Progress">
        <p className="card-label">Run log</p>
        {recordedRows(state) ? (
          <ol className="timeline">
            {(recordedRows(state) ?? []).map((row) => (
              <li key={row.key} data-key={row.key}>
                <span className="timeline-node" aria-hidden="true" />
                <span className="timeline-label">{row.label}</span>
                <span className="timeline-at mono">{row.at}</span>
              </li>
            ))}
          </ol>
        ) : state.stages.length === 0 && !running ? (
          <p className="timeline-empty">No stages ran.</p>
        ) : (
          <ol className="timeline">
            {state.stages.map((s) => (
              <li key={s.key} data-key={s.key}>
                <span className="timeline-node" aria-hidden="true" />
                <span className="timeline-label">{s.label}</span>
                <span className="timeline-at mono">{seconds(s.at)}</span>
              </li>
            ))}
            {running && (
              <li className="timeline-live">
                <span className="timeline-node" aria-hidden="true" />
                <span className="timeline-label">
                  <span className="stage-pulse" aria-hidden="true" />
                  <span className="visually-hidden">Working</span>
                </span>
                <span className="timeline-at mono">{seconds(elapsed)}</span>
              </li>
            )}
          </ol>
        )}
      </section>

      {!failed && (
        <ul className="stats" aria-label="Counts">
          {statsFor(state, elapsed).map((s) => (
            <li key={s.label} className="card stat" data-tone={s.tone}>
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
