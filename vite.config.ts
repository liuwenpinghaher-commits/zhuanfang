import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const VAD_ORT_MODULE_PREFIX = "/vad/ort/";
const VAD_ORT_MODULE_BASENAME = /^ort-wasm(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*\.mjs$/;

function serveVadRuntimeModules(): Plugin {
  return {
    name: "serve-vad-runtime-modules",
    enforce: "pre",
    apply: "serve",
    configureServer(server) {
      const runtimeRoot = resolve(server.config.publicDir, "vad", "ort");

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://vite.local").pathname;
        if (!pathname.startsWith(VAD_ORT_MODULE_PREFIX)) return next();

        let moduleName: string;
        try {
          moduleName = decodeURIComponent(pathname.slice(VAD_ORT_MODULE_PREFIX.length));
        } catch {
          response.statusCode = 404;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Not found");
          return;
        }

        const modulePath = resolve(runtimeRoot, moduleName);
        if (
          !VAD_ORT_MODULE_BASENAME.test(moduleName)
          || modulePath !== `${runtimeRoot}${sep}${moduleName}`
        ) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Not found");
          return;
        }

        try {
          const source = await readFile(modulePath);
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end("Not found");
            return;
          }
          next(error as Error);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [serveVadRuntimeModules(), react()],
  resolve: {
    // The package root points at a pre-bundled monolithic ESM file that cannot be
    // tree-shaken below the chunk gate. The published package also ships its source;
    // resolving the lazy import to that entry lets Rollup retain only Room APIs used here.
    alias: {
      "livekit-client/source": fileURLToPath(new URL("./node_modules/livekit-client/src/index.ts", import.meta.url))
    }
  },
  // Fixed dev/preview ports for this project: web 3220, API 3210.
  // strictPort fails loudly instead of silently drifting to another port.
  server: { host: "127.0.0.1", port: 3220, strictPort: true },
  preview: { host: "127.0.0.1", port: 3220, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // React keeps a stable cache boundary. LiveKit is intentionally absent here:
        // src/realtime/livekitVoice.ts dynamically imports it only when that voice mode is selected.
        manualChunks: {
          "vendor-react": ["react", "react-dom"]
        }
      }
    }
  },
  test: {
    environment: "jsdom",
    // Playwright specs live under tests/e2e — never execute them via Vitest.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/e2e/**",
      "**/*.spec.ts"
    ],

    setupFiles: ["./tests/vitest.setup.ts"],
    env: {
      DEPLOYMENT_PROFILE: "local",
      PRODUCT_API_TOKEN: "",
      PRODUCT_WEB_ORIGINS: "",
      PRODUCT_STATIC_DIR: "",
      RATE_LIMIT_DISABLED: "true",
      VITEST: "true",
      PRODUCT_STORE: "memory"
    }
  }
});
