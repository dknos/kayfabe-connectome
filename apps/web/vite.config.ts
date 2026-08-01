import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const MATERIALIZED = fileURLToPath(new URL("../../data/materialized", import.meta.url));

/** Serve data/materialized at /data/* in dev and preview. Read-only, path-jailed. */
function materializedData(): Plugin {
  const handler = (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith("/data/")) return next();
    const rel = normalize(decodeURIComponent(req.url.slice(6).split("?")[0]));
    if (rel.startsWith("..") || rel.includes("\0")) {
      res.statusCode = 400;
      return res.end("bad path");
    }
    const file = join(MATERIALIZED, rel);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end("not materialized");
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".json") ? "application/json" : "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(file));
  };
  return {
    name: "kayfabe-materialized-data",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), materializedData()],
  server: { port: 9460, strictPort: true, host: "127.0.0.1" },
  preview: { port: 9461, strictPort: true, host: "127.0.0.1" },
  build: { chunkSizeWarningLimit: 1200 },
});
