import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installGoogleAnalytics } from "./analytics";
import { ContextGatheringApp } from "./context-gathering/ContextGatheringApp";
import "./styles.css";

installGoogleAnalytics(import.meta.env.VITE_GA_MEASUREMENT_ID);

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <ContextGatheringApp />
  </StrictMode>,
);
