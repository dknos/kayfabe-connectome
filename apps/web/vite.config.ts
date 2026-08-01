import react from "@vitejs/plugin-react";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const MATERIALIZED = fileURLToPath(new URL("../../data/materialized", import.meta.url));

/**
 * Serve Cesium's Workers / Assets / Widgets / ThirdParty from our OWN origin
 * at /cesium/, in dev and in the build.
 *
 * Cesium resolves those at runtime against `window.CESIUM_BASE_URL`, so they
 * cannot be bundled — they have to exist as static files. Copying them
 * ourselves (rather than taking a plugin dependency) also keeps the globe
 * fully self-hosted: no CDN script tag, no Ion token, and the bundled Natural
 * Earth II basemap under Assets/Textures means the lens renders identically
 * with the network switched off, which is what makes the Playwright journeys
 * hermetic.
 */
function cesiumAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const build = join(dirname(require.resolve("cesium/package.json")), "Build", "Cesium");
  const SUBDIRS = ["Workers", "Assets", "Widgets", "ThirdParty"];
  const serve = (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith("/cesium/")) return next();
    const rel = normalize(decodeURIComponent(req.url.slice(8).split("?")[0]));
    if (rel.startsWith("..") || rel.includes("\0")) {
      res.statusCode = 400;
      return res.end("bad path");
    }
    const file = join(build, rel);
    if (!existsSync(file) || !statSync(file).isFile()) return next();
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".json")
          ? "application/json"
          : file.endsWith(".xml")
            ? "application/xml"
            : file.endsWith(".png")
              ? "image/png"
              : file.endsWith(".jpg")
                ? "image/jpeg"
                : file.endsWith(".svg")
                  ? "image/svg+xml"
                  : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.end(readFileSync(file));
  };
  return {
    name: "kayfabe-cesium-assets",
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    closeBundle() {
      const out = fileURLToPath(new URL("./dist/cesium", import.meta.url));
      for (const sub of SUBDIRS) {
        const from = join(build, sub);
        if (existsSync(from)) cpSync(from, join(out, sub), { recursive: true });
      }
    },
  };
}

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
  // GitHub Pages serves a project site from /<repo>/. KAYFABE_BASE lets the
  // deploy set that without hard-coding a host into the source.
  base: process.env.KAYFABE_BASE ?? "/",
  plugins: [react(), materializedData(), cesiumAssets()],
  server: { port: 9460, strictPort: true, host: "127.0.0.1" },
  preview: { port: 9461, strictPort: true, host: "127.0.0.1" },
  // Cesium is one large prebuilt ESM bundle and lands in its own dynamic
  // chunk, imported only when the GEO lens opens.
  build: { chunkSizeWarningLimit: 4096 },
});
