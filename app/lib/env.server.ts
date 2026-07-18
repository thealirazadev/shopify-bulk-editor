// Fails fast at startup if a required environment variable is missing, per
// docs/architecture.md's "Required environment variables" table.
const REQUIRED_VARS = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SCOPES",
  "SHOPIFY_APP_URL",
  "DATABASE_URL",
] as const;

export function assertRequiredEnv(): void {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. Copy .env.example to .env and fill in real values.`,
    );
  }
}

assertRequiredEnv();
