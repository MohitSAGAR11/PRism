import { useMemo } from "react";
import { basename, SEVERITY_LABEL } from "../format";
import type { LiveCandidate } from "../review-state";

interface SpectrumProps {
  candidates: LiveCandidate[] | null;
  letters: Map<string, string>;
  /** True while pass 1 has not reported yet. */
  scanning: boolean;
  onSelect?: (id: string) => void;
}

interface Placed {
  c: LiveCandidate;
  x: number;
  letter: string;
}

interface Segment {
  file: string;
  from: number;
  to: number;
}

/**
 * Lay candidates out like lines on a spectral plate: one equal segment per
 * file (sorted by path), lines spaced by line number within it. Position is
 * deterministic, so a line never jumps between the live stream and the result.
 */
function layout(candidates: LiveCandidate[], letters: Map<string, string>): { placed: Placed[]; segments: Segment[] } {
  const files = [...new Set(candidates.map((c) => c.file))].sort((a, b) => a.localeCompare(b));
  const width = 100 / Math.max(1, files.length);
  const segments = files.map((file, i) => ({ file, from: i * width, to: (i + 1) * width }));
  const placed: Placed[] = [];
  files.forEach((file, i) => {
    const inFile = candidates.filter((c) => c.file === file).sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
    inFile.forEach((c, j) => {
      const x = i * width + ((j + 1) / (inFile.length + 1)) * width;
      placed.push({ c, x, letter: letters.get(c.id) ?? "?" });
    });
  });
  return { placed, segments };
}

const STATUS_TEXT = { pending: "awaiting verdict", refuted: "refuted", survived: "survived" } as const;

export function Spectrum({ candidates, letters, scanning, onSelect }: SpectrumProps) {
  const { placed, segments } = useMemo(
    () => (candidates ? layout(candidates, letters) : { placed: [], segments: [] }),
    [candidates, letters],
  );

  const empty = candidates !== null && candidates.length === 0;

  return (
    <figure className="spectrum" data-scanning={scanning || undefined} data-empty={empty || undefined}>
      <div className="spectrum-field" role="list" aria-label="Candidate findings">
        {placed.map(({ c, x, letter }) => (
          <button
            key={c.id}
            type="button"
            role="listitem"
            className="spectrum-line"
            data-status={c.status}
            data-severity={c.severity}
            style={{ left: `${x}%` }}
            onClick={() => onSelect?.(c.id)}
            aria-label={`${letter}: ${c.title}. ${SEVERITY_LABEL[c.severity]} ${c.category}, ${STATUS_TEXT[c.status]}.`}
            title={`${letter} · ${c.title}`}
          >
            <span className="spectrum-letter">{letter}</span>
            <span className="spectrum-ghost" aria-hidden="true" />
            <span className="spectrum-stroke" aria-hidden="true" />
            <span className="spectrum-foot" aria-hidden="true" />
          </button>
        ))}
        <div className="spectrum-band" aria-hidden="true" />
      </div>
      <div className="spectrum-scale" aria-hidden="true">
        {segments.map((s) => (
          <span key={s.file} className="spectrum-segment" style={{ left: `${s.from}%`, width: `${s.to - s.from}%` }}>
            <span className="spectrum-tick" />
            <span className="spectrum-file" title={s.file}>
              {basename(s.file)}
            </span>
          </span>
        ))}
        {segments.length === 0 && (
          <span className="spectrum-file spectrum-file-idle">
            {scanning ? "Each candidate will appear here as a line" : empty ? "No candidate lines: an unbroken continuum" : " "}
          </span>
        )}
      </div>
    </figure>
  );
}
