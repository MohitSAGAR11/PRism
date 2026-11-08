import { useState } from "react";

const WORKFLOW = `# .github/workflows/review.yml
name: AI review
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read        # never write
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # base revision only
      - uses: MohitSAGAR11/PRism@main
        with:
          openrouter-api-key: \${{ secrets.OPENROUTER_API_KEY }}
          github-token: \${{ github.token }}`;

const STEPS = [
  {
    name: "Find",
    body:
      "Pass 1 reads the diff with the full file around it and must attach a concrete failing input to every finding. " +
      "“orders=[] makes total() divide by zero” qualifies. “Consider extracting this method” cannot, so it never gets raised.",
  },
  {
    name: "Refute",
    body:
      "Each candidate goes to a second model, from a different provider by default, with one instruction: assume the finding is wrong " +
      "and find the guard, type, or caller that proves it. If the verifier is unsure, the finding is dropped.",
  },
  {
    name: "Post what survives",
    body:
      "Survivors become inline comments on their line, or a summary entry when the line sits outside the diff. " +
      "Fingerprints are keyed on the line's content, not its number, so a later push does not repeat a comment.",
  },
];

export function HowItWorks() {
  return (
    <section className="how" id="how" aria-labelledby="how-title">
      <h2 id="how-title">Two passes, and the second one is hostile</h2>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.name}>
            <span className="how-line" data-step={i} aria-hidden="true" />
            <h3>{s.name}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="how-note">
        This page is a read-only dry run: it reads public pull requests through the GitHub API and never writes to them.
        Diffs are capped at the demo's size limit; the Action has no such cap.
      </p>
    </section>
  );
}

export function Install() {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(WORKFLOW);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 2000);
  }

  const label = copied === "done" ? "Copied" : copied === "failed" ? "Copy blocked" : "Copy";

  return (
    <section className="install" id="install" aria-labelledby="install-title">
      <div className="install-text">
        <h2 id="install-title">Put it on your repository</h2>
        <p>
          Add <code>OPENROUTER_API_KEY</code> as a repository secret, then commit this workflow. Every push to a pull
          request gets reviewed. It comments, and never approves or blocks.
        </p>
        <p>
          It reads code through the API and never checks out or runs anything from the pull request, which is what makes{" "}
          <code>pull_request_target</code> safe on fork PRs here.
        </p>
        <p>
          <a href="https://github.com/MohitSAGAR11/PRism" target="_blank" rel="noopener noreferrer">
            Source, configuration, and security notes on GitHub
          </a>
        </p>
      </div>
      <figure className="snippet">
        <figcaption>
          <span className="mono">review.yml</span>
          <button type="button" className="btn btn-small" onClick={copy} aria-live="polite">
            {label}
          </button>
        </figcaption>
        <pre>
          <code>{WORKFLOW}</code>
        </pre>
      </figure>
    </section>
  );
}
