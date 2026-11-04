import React from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";

// A rendering bug must never leave a blank page: show a readable message and a reload button.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("UI error", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="center" role="alert">
        <h1>Something went wrong</h1>
        <p>The page hit an unexpected error. The forecast data is not affected.</p>
        <button type="button" onClick={() => location.reload()}>Reload the page</button>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
