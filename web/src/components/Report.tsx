import type { WebFinding, WebReviewResult } from "../../../src/server/types";
import { percent, PLACEMENT_LABEL, seconds, SEVERITY_LABEL, shortModel, tokens, usd } from "../format";
import { DiffExcerpt } from "./DiffExcerpt";

interface ReportProps {
  result: WebReviewResult;
  letters: Map<string, string>;
  cached: boolean;
}

function SeverityMark({ finding }: { finding: WebFinding }) {
  return (
    <span className="sev" data-severity={finding.severity}>
      <span className="sev-dot" aria-hidden="true" />
      {SEVERITY_LABEL[finding.severity]}
    </span>
  );
}

function Comment({ finding, letter }: { finding: WebFinding; letter: string }) {
  return (
    <>
      <p className="comment-head">
        <span className="letter-chip">{letter}</span>
        <SeverityMark finding={finding} />
        <span className="comment-cat">{finding.category}</span>
      </p>
      <p className="comment-body">{finding.body}</p>
      <p className="fails">
        <span className="fails-label">Fails when</span> {finding.failureScenario}
      </p>
      {finding.suggestion && (
        <div className="suggestion">
          <span className="suggestion-label">Suggested change</span>
          <pre>
            <code>{finding.suggestion}</code>
          </pre>
        </div>
      )}
    </>
  );
}

function Correction({ finding }: { finding: WebFinding }) {
  if (!finding.original) return null;
  const parts: string[] = [];
  if (finding.original.severity !== finding.severity) {
    parts.push(`severity ${finding.original.severity} to ${finding.severity}`);
  }
  if (finding.original.confidence !== finding.confidence) {
    parts.push(`confidence ${percent(finding.original.confidence)} to ${percent(finding.confidence)}`);
  }
  return parts.length ? <span> Corrected {parts.join(", ")}.</span> : null;
}

function ReportedFinding({ finding, letter, result }: { finding: WebFinding; letter: string; result: WebReviewResult }) {
  const diff = result.diffs.find((d) => d.path === finding.file);
  return (
    <article className="finding" id={`finding-${finding.id}`} tabIndex={-1}>
      <header className="finding-head">
        <h3>
          <span className="finding-letter">{letter}</span>
          {finding.title}
        </h3>
        <p className="finding-meta">
          <span className="mono">
            {finding.file}:{finding.line}
          </span>
          <span>{PLACEMENT_LABEL[finding.placement]}</span>
          <span>{percent(finding.confidence)} confidence</span>
        </p>
      </header>
      <DiffExcerpt diff={diff} line={finding.line} letter={letter} comment={<Comment finding={finding} letter={letter} />} />
      {finding.verdict && (
        <p className="verdict-note">
          <span className="verdict-label">Survived refutation.</span> {finding.verdict.reason}
          <Correction finding={finding} />
        </p>
      )}
    </article>
  );
}

function RefutedRow({ finding, letter }: { finding: WebFinding; letter: string }) {
  return (
    <li className="struck" id={`finding-${finding.id}`} tabIndex={-1}>
      <details>
        <summary>
          <span className="struck-letter">{letter}</span>
          <span className="struck-title">{finding.title}</span>
          <span className="struck-where mono">
            {finding.file}:{finding.line}
          </span>
          <SeverityMark finding={finding} />
        </summary>
        <div className="struck-detail">
          <p>{finding.body}</p>
          <p className="fails">
            <span className="fails-label">Claimed failure</span> {finding.failureScenario}
          </p>
        </div>
      </details>
      <p className="struck-reason">
        <span className="stamp">Refuted</span> {finding.verdict?.reason ?? "No reason given."}
      </p>
    </li>
  );
}

function WithheldRow({ finding, letter }: { finding: WebFinding; letter: string }) {
  return (
    <li className="withheld" id={`finding-${finding.id}`} tabIndex={-1}>
      <span className="struck-letter">{letter}</span>
      <span className="struck-title">{finding.title}</span>
      <span className="struck-where mono">
        {finding.file}:{finding.line}
      </span>
      <span className="withheld-why">
        {PLACEMENT_LABEL[finding.placement]} ({SEVERITY_LABEL[finding.severity].toLowerCase()}, {percent(finding.confidence)})
      </span>
    </li>
  );
}

function summarize(result: WebReviewResult): string {
  const s = result.stats;
  const files = `${s.filesReviewed} ${s.filesReviewed === 1 ? "file" : "files"}`;
  if (s.candidates === 0) {
    return `Read ${files}. Pass 1 found nothing it could tie to a concrete failing input, so there was nothing to refute.`;
  }
  const raised = `Pass 1 raised ${s.candidates} ${s.candidates === 1 ? "candidate" : "candidates"} across ${files}.`;
  const refuted = s.refuted === s.candidates ? " Pass 2 refuted every one." : ` Pass 2 refuted ${s.refuted}.`;
  const reported =
    s.reported === 0 ? " Nothing would be posted." : ` ${s.reported} would be posted to the pull request.`;
  return raised + refuted + reported;
}

export function Report({ result, letters, cached }: ReportProps) {
  const letterOf = (f: WebFinding): string => letters.get(f.id) ?? "?";
  // Rows read in letter order, left to right along the spectrum.
  const byLetter = (a: WebFinding, b: WebFinding): number =>
    letterOf(a).length - letterOf(b).length || letterOf(a).localeCompare(letterOf(b));
  const reported = result.findings.filter((f) => f.placement === "inline" || f.placement === "summary");
  const refuted = result.findings.filter((f) => f.placement === "refuted").sort(byLetter);
  const withheld = result.findings.filter((f) => f.placement === "below-bar" || f.placement === "duplicate").sort(byLetter);
  const quiet = reported.length === 0;

  return (
    <section className="report" aria-labelledby="report-title">
      <header className="report-head">
        <h2 id="report-title">
          <a href={result.pr.url} target="_blank" rel="noopener noreferrer">
            {result.pr.owner}/{result.pr.repo} <span className="report-num">#{result.pr.number}</span>
          </a>
        </h2>
        <p className="report-summary">{summarize(result)}</p>
      </header>

      {quiet ? (
        <div className="quiet">
          <p className="quiet-title">Nothing worth saying.</p>
          <p>
            PRism would post a one-line summary and no inline comments. An empty review is the correct review for most
            pull requests: a bot that comments on everything gets muted within a week.
          </p>
        </div>
      ) : (
        <div className="findings">
          <h3 className="section-title">Would be posted</h3>
          {reported.map((f) => (
            <ReportedFinding key={f.id} finding={f} letter={letterOf(f)} result={result} />
          ))}
        </div>
      )}

      {refuted.length > 0 && (
        <div className="refuted">
          <h3 className="section-title">
            Refuted by pass 2 <span className="count">{refuted.length}</span>
          </h3>
          <p className="section-note">
            Each candidate went back to a second model told to assume it was wrong. Uncertainty counts as a refutation.
            Nothing is hidden: this is the block PRism folds into its summary comment.
          </p>
          <ol className="struck-list">
            {refuted.map((f) => (
              <RefutedRow key={f.id} finding={f} letter={letterOf(f)} />
            ))}
          </ol>
        </div>
      )}

      {withheld.length > 0 && (
        <div className="withheld-block">
          <h3 className="section-title">
            Withheld <span className="count">{withheld.length}</span>
          </h3>
          <ol className="struck-list">
            {withheld.map((f) => (
              <WithheldRow key={f.id} finding={f} letter={letterOf(f)} />
            ))}
          </ol>
        </div>
      )}

      {result.failures.length > 0 && (
        <div className="failures" role="note">
          <h3 className="section-title">Partly reviewed</h3>
          <ul>
            {result.failures.map((f, i) => (
              <li key={i}>
                <span className="mono">{f.paths.join(", ")}</span>: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="files">
        <summary>
          {result.reviewedFiles.length} reviewed {result.reviewedFiles.length === 1 ? "file" : "files"}
          {result.skipped.length > 0 && `, ${result.skipped.length} skipped`}
        </summary>
        <ul className="file-list">
          {result.reviewedFiles.map((f) => (
            <li key={f.path}>
              <span className="mono">{f.path}</span>
              <span className="file-delta">
                <span className="add">+{f.additions}</span> <span className="del">-{f.deletions}</span>
              </span>
            </li>
          ))}
          {result.skipped.map((f) => (
            <li key={f.path} className="file-skipped">
              <span className="mono">{f.path}</span>
              <span className="file-delta">{f.reason}</span>
            </li>
          ))}
        </ul>
      </details>

      <dl className="meta">
        <div>
          <dt>Find</dt>
          <dd className="mono">{shortModel(result.config.model)}</dd>
        </div>
        <div>
          <dt>Refute</dt>
          <dd className="mono">{shortModel(result.config.verifyModel)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd className="mono">
            {tokens(result.usage.promptTokens)} in / {tokens(result.usage.completionTokens)} out
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd className="mono">{usd(result.usage.cost)}</dd>
        </div>
        <div>
          <dt>Took</dt>
          <dd className="mono">
            {seconds(result.stats.durationMs)}
            {cached ? ", cached" : ""}
          </dd>
        </div>
        <div>
          <dt>Head</dt>
          <dd className="mono">{result.pr.headSha.slice(0, 7)}</dd>
        </div>
      </dl>
    </section>
  );
}
