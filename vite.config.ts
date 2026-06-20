import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Fixed dev/preview ports for this project: web 3220, API 3210.
  // strictPort fails loudly instead of silently drifting to another port.
  server: { host: "127.0.0.1", port: 3220, strictPort: true },
  preview: { host: "127.0.0.1", port: 3220, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        // Split heavy/独立 vendors out of the main app chunk (was a single ~950KB file).
        // livekit-client is only needed for the LiveKit voice path; react in its own chunk
        // caches across deploys.
        manualChunks: {
          "vendor-livekit": ["livekit-client"],
          "vendor-react": ["react", "react-dom"]
        }
      }
    }
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
    css: true
  }
});
