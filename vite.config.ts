import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
    css: true
  }
});
