import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";
import "./styles/hero.css";
import "./styles/plate.css";
import "./styles/report.css";
import "./styles/sections.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
