import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./services/auth";
import { startConnectivityMonitor } from "./services/connectivity";
import "./styles.css";

startConnectivityMonitor();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
