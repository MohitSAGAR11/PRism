import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ClientError, fetchConfig, streamReview, type DemoConfig } from "./api";
import { HowItWorks, Install } from "./components/Explainer";
import { Plate } from "./components/Plate";
import { Report } from "./components/Report";
import { ReviewForm } from "./components/ReviewForm";
import { Samples } from "./components/Samples";
import { looksLikePullUrl } from "./format";
import { IDLE, letterMap, reduce } from "./review-state";

function setShareableUrl(prUrl: string | null): void {
  const next = new URL(window.location.href);
  if (prUrl) next.searchParams.set("pr", prUrl);
  else next.searchParams.delete("pr");
  window.history.replaceState(null, "", next);
}

export function App() {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [url, setUrl] = useState("");
  const plateRef = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const booted = useRef(false);

  const refreshConfig = useCallback(async (): Promise<DemoConfig | null> => {
    try {
      const next = await fetchConfig();
      setConfig(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const run = useCallback(
    (url: string, sample = false) => {
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      dispatch({ type: "start", url, now: Date.now() });
      setShareableUrl(sample ? null : url);
      streamReview(url, apiKey.trim() || null, (event) => dispatch({ type: "event", event, now: Date.now() }), c.signal)
        .catch((err: unknown) => {
          if (c.signal.aborted) return;
          if (err instanceof ClientError) {
            dispatch({ type: "fail", code: err.code, message: err.message, retryAfterSec: err.retryAfterSec });
          } else {
            dispatch({ type: "fail", code: "internal", message: "Something went wrong in the page. Reload and try again." });
          }
        })
        .finally(() => {
          if (!c.signal.aborted) void refreshConfig();
        });
    },
    [apiKey, refreshConfig],
  );

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void refreshConfig().then((cfg) => {
      const shared = new URLSearchParams(window.location.search).get("pr");
      if (shared && looksLikePullUrl(shared)) return run(shared);
      const first = cfg?.samples.find((s) => s.cached);
      if (first) run(first.url, true);
    });
  }, [refreshConfig, run]);

  function runFromUser(next: string, sample = false): void {
    setUrl(next);
    run(next, sample);
    if (window.matchMedia("(max-width: 960px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.requestAnimationFrame(() => plateRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
    }
  }

  const letters = useMemo(() => letterMap(state.candidates ?? []), [state.candidates]);
  const isSample = config?.samples.some((s) => s.url === state.url) ?? false;

  function selectFinding(id: string): void {
    const el = document.getElementById(`finding-${id}`);
    if (!el) return;
    if (el instanceof HTMLElement && el.querySelector("details") instanceof HTMLDetailsElement) {
      (el.querySelector("details") as HTMLDetailsElement).open = true;
    }
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }

  function useOwnKey(): void {
    setKeyOpen(true);
    window.requestAnimationFrame(() => keyInputRef.current?.focus());
  }

  return (
    <>
      <a className="skip" href="#main">
        Skip to the review
      </a>
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="PRism home">
          PRism
        </a>
        <nav aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#install">Install</a>
          <a href="https://github.com/MohitSAGAR11/PRism" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">A code reviewer that argues with itself.</h1>
            <p className="lede">
              Pass 1 finds candidate defects. Pass 2 tries to refute every one. You see what survives, and why the rest
              did not.
            </p>
            <ReviewForm
              config={config}
              running={state.phase === "running"}
              url={url}
              onUrlChange={setUrl}
              keyOpen={keyOpen}
              onKeyOpenChange={setKeyOpen}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              onSubmit={(next) => runFromUser(next)}
              keyInputRef={keyInputRef}
            />
          </div>
          <div className="hero-plate" ref={plateRef}>
          <Plate
            state={state}
            letters={letters}
            isSample={isSample}
            onSelect={selectFinding}
            onRetry={() => run(state.url, isSample)}
            onUseOwnKey={useOwnKey}
          />
          </div>
          <div className="hero-samples">
            <Samples
              samples={config?.samples ?? []}
              activeUrl={state.url}
              running={state.phase === "running"}
              onRun={(next) => runFromUser(next, true)}
            />
          </div>
        </section>

        {state.result && <Report result={state.result} letters={letters} cached={state.cached} />}

        <HowItWorks />
        <Install />
      </main>

      <footer className="footer">
        <p>
          PRism by{" "}
          <a href="https://github.com/MohitSAGAR11" target="_blank" rel="noopener noreferrer">
            MohitSAGAR11
          </a>
          . Models via OpenRouter. This demo never writes to GitHub.
        </p>
      </footer>
    </>
  );
}
