import type { SampleInfo } from "../../../src/server/types";

interface SamplesProps {
  samples: SampleInfo[];
  activeUrl: string;
  running: boolean;
  onRun: (url: string) => void;
}

export function Samples({ samples, activeUrl, running, onRun }: SamplesProps) {
  if (samples.length === 0) return null;
  return (
    <div className="samples">
      <p className="samples-title">Or open a real review</p>
      <ul>
        {samples.map((s) => {
          const current = activeUrl === s.url;
          const state = current ? "showing" : s.cached ? "instant" : "runs live";
          return (
            <li key={s.url}>
              <button
                type="button"
                className="sample"
                aria-current={current || undefined}
                onClick={() => onRun(s.url)}
                disabled={running}
              >
                <span className="sample-ref mono">{s.label}</span>
                <span className="sample-blurb">{s.blurb}</span>
                <span className="sample-state">{state}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
