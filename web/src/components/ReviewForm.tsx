import { useId, useRef, useState, type FormEvent } from "react";
import type { DemoConfig } from "../api";
import { looksLikePullUrl } from "../format";

interface ReviewFormProps {
  config: DemoConfig | null;
  running: boolean;
  url: string;
  onUrlChange: (url: string) => void;
  keyOpen: boolean;
  onKeyOpenChange: (open: boolean) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onSubmit: (url: string) => void;
  keyInputRef: React.RefObject<HTMLInputElement | null>;
}

function quotaLine(config: DemoConfig | null, hasKey: boolean): string {
  if (!config) return "";
  if (hasKey) return "Using your key for this review only.";
  if (!config.quota.serverKey) return "This deployment has no shared key. Bring your own to run a review.";
  const { remaining, limit } = config.quota;
  return `${remaining} of ${limit} shared reviews left this hour. Samples and repeat reviews are free.`;
}

export function ReviewForm(props: ReviewFormProps) {
  const { config, running, url, onUrlChange, keyOpen, onKeyOpenChange, apiKey, onApiKeyChange, onSubmit, keyInputRef } = props;
  const [touched, setTouched] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const ids = { url: useId(), urlHint: useId(), key: useId(), keyHint: useId() };

  const invalid = touched && url.trim() !== "" && !looksLikePullUrl(url);

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    setTouched(true);
    if (!looksLikePullUrl(url)) {
      urlInput.current?.focus();
      return;
    }
    onSubmit(url.trim());
  }


  return (
    <div className="console">
      <form className="review-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor={ids.url} className="field-label">
          Public pull request
        </label>
        <div className="field-row" data-invalid={invalid || undefined}>
          <input
            ref={urlInput}
            id={ids.url}
            className="field"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo/pull/123"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={invalid}
            aria-describedby={ids.urlHint}
          />
          <button type="submit" className="btn btn-primary btn-run" disabled={running}>
            {running ? "Reviewing" : "Review"}
          </button>
        </div>
        <p id={ids.urlHint} className={invalid ? "field-hint field-error" : "field-hint"}>
          {invalid
            ? "Use the pull request's own URL, like github.com/owner/repo/pull/123."
            : quotaLine(config, apiKey.trim() !== "")}
        </p>

        <div className="key">
          <button
            type="button"
            className="link-button"
            aria-expanded={keyOpen}
            aria-controls={ids.key}
            onClick={() => onKeyOpenChange(!keyOpen)}
          >
            {keyOpen ? "Hide own key" : "Use your own OpenRouter key"}
          </button>
          {keyOpen && (
            <div className="key-field">
              <label htmlFor={ids.key} className="visually-hidden">
                OpenRouter API key
              </label>
              <input
                ref={keyInputRef}
                id={ids.key}
                className="field field-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-or-v1-…"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                aria-describedby={ids.keyHint}
              />
              <p id={ids.keyHint} className="field-hint">
                Sent with this one request, used for its model calls, then dropped. Never logged, stored, or cached.
              </p>
            </div>
          )}
        </div>
      </form>

    </div>
  );
}
