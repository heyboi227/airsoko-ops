import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The repository root holds the single .env; every workspace reads that one
// file rather than keeping its own copy to drift out of sync.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env"), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required -- copy .env.example to .env"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  SEED: z.string().default("airsoko-2026"),

  TELEMETRY_PROVIDER: z.enum(["simulation", "external"]).default("simulation"),
  TELEMETRY_TICK_MS: z.coerce.number().int().min(250).max(60_000).default(2000),

  WEB_ORIGIN: z.string().default("http://localhost:5273"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  // Fail loudly at boot rather than with a confusing error on first query.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
