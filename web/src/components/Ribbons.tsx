const FILLED = [
  "Find",
  "Refute",
  "Post what survives",
  "Failure scenario required",
  "Quiet by default",
  "Read-only demo",
];

const OUTLINED = [
  "Uncertain counts as refuted",
  "Content-keyed fingerprints",
  "Inline when anchorable",
  "Never approves, never blocks",
  "Any model via OpenRouter",
];

function Track({ words }: { words: string[] }) {
  // Two copies so the loop is seamless at translateX(-50%).
  const run = [...words, ...words];
  return (
    <div className="ribbon-track">
      {[0, 1].map((copy) => (
        <span className="ribbon-run" key={copy} aria-hidden={copy === 1 || undefined}>
          {run.map((w, i) => (
            <span className="ribbon-word" key={`${copy}-${i}`}>
              {w}
              <span className="ribbon-dot" aria-hidden="true" />
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/** Two crossing marquee bands that restate the mechanism. Decorative. */
export function Ribbons() {
  return (
    <div className="ribbons" aria-hidden="true">
      <div className="ribbon ribbon-filled">
        <Track words={FILLED} />
      </div>
      <div className="ribbon ribbon-outlined">
        <Track words={OUTLINED} />
      </div>
    </div>
  );
}
