import { useEffect, useState } from "react";
import type { ReviewState } from "../review-state";

interface ErrorPanelProps {
  error: NonNullable<ReviewState["error"]>;
  onRetry: () => void;
  onUseOwnKey: () => void;
}

const TITLES: Record<string, string> = {
  invalid_url: "That is not a pull request URL",
  invalid_key: "A model key is needed",
  not_found: "Pull request not found",
  private_repo: "Private repositories stay private",
  too_large: "Too large for the demo",
  rate_limited: "Shared reviews used up for now",
  busy: "The demo is busy",
  github_error: "GitHub did not answer",
  model_error: "The model call failed",
  timeout: "The review ran out of time",
  network: "Connection lost",
  internal: "Something broke on our side",
};

function useCountdown(seconds: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [seconds]);
  return left;
}

function clock(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function ErrorPanel({ error, onRetry, onUseOwnKey }: ErrorPanelProps) {
  const left = useCountdown(error.retryAfterSec);
  const offersKey = ["rate_limited", "model_error", "invalid_key"].includes(error.code);
  const retryable = ["busy", "github_error", "timeout", "network", "internal", "rate_limited", "model_error"].includes(
    error.code,
  );
  const pointsToAction = ["private_repo", "too_large"].includes(error.code);

  return (
    <div className="error-panel" role="alert" data-code={error.code}>
      <p className="error-title">{TITLES[error.code] ?? "The review failed"}</p>
      <p className="error-message">{error.message}</p>
      <div className="error-actions">
        {offersKey && (
          <button type="button" className="btn btn-primary" onClick={onUseOwnKey}>
            Use my own OpenRouter key
          </button>
        )}
        {retryable && (
          <button type="button" className="btn" onClick={onRetry} disabled={left > 0}>
            {left > 0 ? `Try again in ${clock(left)}` : "Try again"}
          </button>
        )}
        {pointsToAction && (
          <a className="btn btn-primary" href="#install">
            Install the Action
          </a>
        )}
      </div>
    </div>
  );
}
