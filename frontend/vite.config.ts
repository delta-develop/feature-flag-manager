import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:8000";

// Same-origin in dev: proxy API and docs to the backend, so no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": backend,
      "/healthz": backend,
      "/docs": backend,
      "/openapi.json": backend,
    },
  },
});
