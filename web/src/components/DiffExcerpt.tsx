import type { ReactNode } from "react";
import type { WebDiffLine, WebFileDiff } from "../../../src/server/types";

interface DiffExcerptProps {
  diff: WebFileDiff | undefined;
  line: number;
  letter: string;
  /** Rendered directly under the cited line, the way GitHub shows a review comment. */
  comment: ReactNode;
}

const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 3;

function locate(diff: WebFileDiff, line: number): { header: string; rows: WebDiffLine[]; target: number } | null {
  for (const hunk of diff.hunks) {
    const idx = hunk.lines.findIndex((l) => l.newLine === line);
    if (idx === -1) continue;
    const from = Math.max(0, idx - CONTEXT_BEFORE);
    const to = Math.min(hunk.lines.length, idx + CONTEXT_AFTER + 1);
    return { header: hunk.header, rows: hunk.lines.slice(from, to), target: idx - from };
  }
  return null;
}

const SIGN = { add: "+", del: "-", context: " " } as const;

export function DiffExcerpt({ diff, line, letter, comment }: DiffExcerptProps) {
  const found = diff ? locate(diff, line) : null;

  if (!found) {
    return (
      <div className="diff-outside">
        <p>
          Line <span className="mono">{line}</span> is outside the diff, so GitHub would not accept an inline comment
          there. PRism would put this finding in the summary comment instead.
        </p>
        <div className="diff-comment">{comment}</div>
      </div>
    );
  }

  return (
    <div className="diff" role="group" aria-label={`Diff around line ${line}`}>
      <div className="diff-scroll">
        <table className="diff-table">
          <caption className="diff-hunk">{found.header.replace(/^(@@[^@]*@@).*$/, "$1")}</caption>
          <tbody>
            {found.rows.map((row, i) => {
              const isTarget = i === found.target;
              return (
                <DiffRow key={`${row.oldLine}-${row.newLine}-${i}`} row={row} isTarget={isTarget} letter={letter} />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="diff-comment" data-anchor={letter}>
        {comment}
      </div>
    </div>
  );
}

function DiffRow({ row, isTarget, letter }: { row: WebDiffLine; isTarget: boolean; letter: string }) {
  return (
    <tr className="diff-row" data-kind={row.kind} data-target={isTarget || undefined}>
      <td className="diff-num">{row.oldLine ?? ""}</td>
      <td className="diff-num">{row.newLine ?? ""}</td>
      <td className="diff-sign" aria-hidden="true">
        {isTarget ? <span className="diff-pin">{letter}</span> : SIGN[row.kind]}
      </td>
      <td className="diff-code">
        <code>{row.content.length > 0 ? row.content : " "}</code>
      </td>
    </tr>
  );
}
