import "src/services/app/boot";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "src/App";
import "./css/globals.css";
import { loadSavedLanguage } from "src/i18n";

void loadSavedLanguage().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
