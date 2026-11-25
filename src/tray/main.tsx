import React from "react";
import ReactDOM from "react-dom/client";
import "src/css/globals.css";
import "./tray.css";
import TrayApp from "./TrayApp";
import { loadSavedLanguage, switchLanguage } from "src/i18n";
import { TRAY_THEME_EVENT } from "./useTrayState";
import {
  APPEARANCE_EVENT,
  APPEARANCE_KEY,
  loadAppearance,
  resolveTrayTheme,
} from "src/features/settings/services/appearance";

// Follow the wallet window's theme and the menu bar theme picked in Appearance (same origin, so
// the stored values and their changes are shared).
const THEME_KEY = "0xio_theme";
const applyTheme = () => {
  const root = document.documentElement;
  let app = "dim";
  try {
    app = localStorage.getItem(THEME_KEY) || "dim";
  } catch {}
  root.setAttribute("data-theme", app);
  root.setAttribute("data-tray", resolveTrayTheme(loadAppearance().trayTheme, app));
  window.dispatchEvent(new Event(TRAY_THEME_EVENT));
};
applyTheme();
window.addEventListener("storage", (e) => {
  if (e.key === THEME_KEY || e.key === APPEARANCE_KEY) applyTheme();
  if (e.key === "app_language" && e.newValue) void switchLanguage(e.newValue);
});
window.addEventListener(APPEARANCE_EVENT, applyTheme);

void loadSavedLanguage().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <TrayApp />
    </React.StrictMode>,
  ),
);
