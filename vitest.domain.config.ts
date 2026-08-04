/**
 * Lightweight Vitest config for domain Must-set tests (no React plugin / VAD middleware).
 * Usage: REAL_PROVIDER_SMOKE=off npx vitest run --config vitest.domain.config.ts <paths>
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/domain/**/*.test.ts",
      "src/realtime/**/*.test.ts",
      "src/api/**/*.test.ts",
      "apps/api/src/routes/**/*.test.ts"
    ],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1
  }
});
