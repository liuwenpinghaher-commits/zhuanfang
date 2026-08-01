import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
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
