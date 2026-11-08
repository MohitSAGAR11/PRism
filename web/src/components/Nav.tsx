import { useEffect, useLayoutEffect, useRef, useState } from "react";

const ITEMS = [
  { id: "top", label: "Try it" },
  { id: "review", label: "Results" },
  { id: "how", label: "How it works" },
  { id: "install", label: "Install" },
] as const;

type SectionId = (typeof ITEMS)[number]["id"];

/** Which section owns the middle of the viewport. */
function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>("top");
  useEffect(() => {
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let best: SectionId = "top";
        let bestRatio = 0;
        for (const item of ITEMS) {
          const r = visible.get(item.id) ?? 0;
          if (r > bestRatio) {
            best = item.id;
            bestRatio = r;
          }
        }
        if (bestRatio > 0) setActive(best);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.01, 0.5, 1] },
    );
    for (const item of ITEMS) {
      const el = document.getElementById(item.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return active;
}

export function Nav() {
  const active = useActiveSection();
  const listRef = useRef<HTMLUListElement>(null);
  const [lamp, setLamp] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const measure = (): void => {
      const link = listRef.current?.querySelector<HTMLElement>(`[data-id="${active}"]`);
      if (link) setLamp({ x: link.offsetLeft, w: link.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);

  return (
    <header className="nav">
      <a className="nav-mark" href="#top" aria-label="PRism, back to top">
        PRism
      </a>
      <nav aria-label="Main" className="nav-pill">
        <ul ref={listRef}>
          {lamp && (
            <li
              className="nav-lamp"
              aria-hidden="true"
              style={{ transform: `translateX(${lamp.x}px)`, width: `${lamp.w}px` }}
            />
          )}
          {ITEMS.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`} data-id={item.id} aria-current={active === item.id ? "true" : undefined}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <a
        className="nav-icon"
        href="https://github.com/MohitSAGAR11/PRism"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="PRism on GitHub"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
      </a>
    </header>
  );
}
