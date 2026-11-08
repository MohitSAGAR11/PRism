import { useEffect } from "react";

/**
 * Fade-and-rise for `[data-reveal]` blocks as they enter the viewport.
 *
 * Content is visible by default: elements are only hidden once the
 * `reveal-ready` class is on <html>, which main.tsx sets when motion is
 * allowed. `deps` re-scans for blocks mounted later (the report).
 */
export function useReveal(deps: unknown[]): void {
  useEffect(() => {
    if (!document.documentElement.classList.contains("reveal-ready")) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    document.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
