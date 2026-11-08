import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";
import "./styles/nav.css";
import "./styles/hero.css";
import "./styles/bento.css";
import "./styles/spectrum.css";
import "./styles/report.css";
import "./styles/sections.css";
import "./styles/responsive.css";

// Scroll reveals hide content until it enters view, so only opt in when the
// visitor allows motion. Without this class everything renders visible.
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("reveal-ready");
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
