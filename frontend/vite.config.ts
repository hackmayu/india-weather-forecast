/// <reference types="vitest" />
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// In static mode (`vite build --mode static`, used for Vercel and other static hosts) copy the exported
// forecast files (frontend/static-data, produced by `python -m precip.export_static`) into dist/data.
// Normal builds do not include them: the FastAPI service answers from its own processed data.
function copyStaticData(): Plugin {
  return {
    name: "copy-static-data",
    apply: "build",
    closeBundle() {
      const src = resolve(__dirname, "static-data");
      if (!existsSync(resolve(src, "index.json"))) throw new Error("static-data/index.json is missing: run `npm run export:data` first");
      cpSync(src, resolve(__dirname, "dist", "data"), { recursive: true });
    },
  };
}

// Dev: proxy /api to the FastAPI server. Prod: FastAPI serves the built files itself (same origin).
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "static" ? [copyStaticData()] : [])],
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: { environment: "node" },
}));
