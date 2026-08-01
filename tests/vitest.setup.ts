/**
 * Hard isolation for unit/integration tests.
 * Sourcing .env.production.local (or exporting production vars) must never
 * change auth/CORS defaults for Vitest runs.
 */
const FORCE_UNSET = [
  "PRODUCT_API_TOKEN",
  "PRODUCT_WEB_ORIGINS",
  "PRODUCT_ENV_FILE",
  "PRODUCT_STATIC_DIR",
  "CORPUS_S3_BUCKET",
  "CORPUS_S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_STRICT_MAX"
] as const;

for (const key of FORCE_UNSET) {
  delete process.env[key];
}

process.env.DEPLOYMENT_PROFILE = "local";
process.env.RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED ?? "true";
process.env.VITEST = process.env.VITEST || "true";
// Avoid accidental production static dir / store leakage in unit tests.
if ((process.env.PRODUCT_STORE ?? "").trim() === "") {
  process.env.PRODUCT_STORE = "memory";
}
