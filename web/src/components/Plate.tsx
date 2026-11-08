import { useEffect, useState } from "react";
import { seconds } from "../format";
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

export function Plate({ state, letters, isSample, onSelect, onRetry, onUseOwnKey }: PlateProps) {
  const running = state.phase === "running";
  const elapsed = useElapsed(running, state.startedAt);
  const verdict = verdictFor(state, elapsed);
  const scanning = running && state.candidates === null;

  if (state.phase === "idle") {
    return (
      <section className="plate plate-idle" aria-label="Review">
        <Spectrum candidates={null} letters={letters} scanning={false} />
        <p className="plate-hint">Paste a pull request or open a sample. Its candidates appear here as lines.</p>
      </section>
    );
  }

  return (
    <section className="plate" aria-label="Review" aria-busy={running}>
      <header className="plate-pr">
        <p className="plate-ref mono">
          {isSample && <span className="plate-tag">Sample</span>}
          {state.cached && !isSample && <span className="plate-tag">Cached</span>}
          {refOf(state.url)}
          {state.pr && <span className="plate-sha">@{state.pr.headSha.slice(0, 7)}</span>}
        </p>
        <p className="plate-title">{state.pr ? state.pr.title : running ? "Fetching the pull request" : "Not reviewed"}</p>
      </header>

      {state.phase === "error" && state.error ? (
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

      {(state.stages.length > 0 || running) && (
      <ol className="stages" aria-label="Progress">
        {state.stages.map((s) => (
          <li key={s.key} data-key={s.key}>
            <span className="stage-at mono">{seconds(s.at)}</span>
            <span>{s.label}</span>
          </li>
        ))}
        {running && (
          <li className="stage-live">
            <span className="stage-at mono">{seconds(elapsed)}</span>
            <span className="stage-pulse" aria-hidden="true" />
            <span className="visually-hidden">Working</span>
          </li>
        )}
      </ol>
      )}
    </section>
  );
}

function refOf(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
  return m ? `${m[1]}/${m[2]} #${m[3]}` : url;
}
