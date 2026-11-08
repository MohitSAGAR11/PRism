import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ClientError, fetchConfig, streamReview, type DemoConfig } from "./api";
import { HowItWorks, Install } from "./components/Explainer";
import { Nav } from "./components/Nav";
import { Plate } from "./components/Plate";
import { Report } from "./components/Report";
import { ReviewForm } from "./components/ReviewForm";
import { Ribbons } from "./components/Ribbons";
import { Samples } from "./components/Samples";
import { looksLikePullUrl } from "./format";
import { IDLE, letterMap, reduce } from "./review-state";
import { useReveal } from "./use-reveal";

function setShareableUrl(prUrl: string | null): void {
  const next = new URL(window.location.href);
  if (prUrl) next.searchParams.set("pr", prUrl);
  else next.searchParams.delete("pr");
  window.history.replaceState(null, "", next);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function App() {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [url, setUrl] = useState("");
  const reviewRef = useRef<HTMLElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const booted = useRef(false);

  useReveal([state.result, state.phase]);

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
    (target: string, sample = false) => {
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      dispatch({ type: "start", url: target, now: Date.now() });
      setShareableUrl(sample ? null : target);
      streamReview(target, apiKey.trim() || null, (event) => dispatch({ type: "event", event, now: Date.now() }), c.signal)
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

  /** A run the visitor started: the results live below the hero, so take them there. */
  function runFromUser(next: string, sample = false): void {
    setUrl(next);
    run(next, sample);
    window.requestAnimationFrame(() =>
      reviewRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }),
    );
  }

  const letters = useMemo(() => letterMap(state.candidates ?? []), [state.candidates]);
  const isSample = config?.samples.some((s) => s.url === state.url) ?? false;

  function selectFinding(id: string): void {
    const el = document.getElementById(`finding-${id}`);
    if (!el) return;
    const details = el.querySelector("details");
    if (details instanceof HTMLDetailsElement) details.open = true;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }

  function useOwnKey(): void {
    setKeyOpen(true);
    document.getElementById("top")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
    window.setTimeout(() => keyInputRef.current?.focus(), prefersReducedMotion() ? 0 : 450);
  }

  return (
    <>
      <a className="skip" href="#review">
        Skip to the review
      </a>
      <Nav />

      <main id="main">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-beams" aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} className="beam" />
            ))}
          </div>
          <div className="hero-inner">
            <h1 id="hero-title" className="display">
              PRism
            </h1>
            <p className="hero-sub">A code reviewer that argues with itself.</p>
            <p className="hero-lede">
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
            <Samples
              samples={config?.samples ?? []}
              activeUrl={state.url}
              running={state.phase === "running"}
              onRun={(next) => runFromUser(next, true)}
            />
          </div>
          <Ribbons />
        </section>

        <section className="section" id="review" ref={reviewRef} aria-labelledby="review-title">
          <h2 id="review-title" className="section-heading" data-reveal>
            The review
          </h2>
          <Plate
            state={state}
            letters={letters}
            isSample={isSample}
            onSelect={selectFinding}
            onRetry={() => run(state.url, isSample)}
            onUseOwnKey={useOwnKey}
          />
          {state.result && <Report result={state.result} letters={letters} cached={state.cached} />}
        </section>

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
