import type { Env } from "./types.js";

// Outlets to include. label = display name, site = domain for Google News RSS filter
export const sources = [
  { label: "BBC", site: "bbc.com" },
  { label: "Reuters", site: "reuters.com" },
  { label: "CNN", site: "cnn.com" },
  { label: "NPR", site: "npr.org" },
  { label: "Al Jazeera", site: "aljazeera.com" },
  { label: "The Guardian", site: "theguardian.com" },
  { label: "AP", site: "apnews.com" },
  { label: "The Hill", site: "thehill.com" },
  { label: "France 24", site: "france24.com" },
  { label: "DW", site: "dw.com" },
  { label: "Sky News", site: "news.sky.com" },
  { label: "CNBC", site: "cnbc.com" },
  { label: "The Verge", site: "theverge.com" },
  { label: "ABC News", site: "abcnews.go.com" },
  { label: "NBC News", site: "nbcnews.com" },
  { label: "USA Today", site: "usatoday.com" },
  { label: "The Independent", site: "independent.co.uk" },
  { label: "Politico", site: "politico.com" },
] as const;

export const DEFAULT_CLUSTER_WINDOW_HOURS = 48;

/** Worker bindings (wrangler vars, .dev.vars, or `wrangler secret put`) */
export function workerConfig(env: Env) {
  return {
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.5-flash",
    // Secondary model used when the primary exhausts its retries
    // (outage, quota, model deprecation).
    geminiModelFallback: env.GEMINI_MODEL_FALLBACK ?? "gemini-3.1-flash-lite",
    // Fail closed: no default fallback. /api/cron returns 503 when unset.
    cronSecret: env.CRON_SECRET ?? "",
    // How far back a story can be to still join a new cluster.
    // Misconfigured values fall back to 48h instead of poisoning the window.
    clusterWindowHours: Number.isFinite(Number(env.CLUSTER_WINDOW_HOURS)) &&
      Number(env.CLUSTER_WINDOW_HOURS) > 0
      ? Number(env.CLUSTER_WINDOW_HOURS)
      : DEFAULT_CLUSTER_WINDOW_HOURS,
    // Max manual pipeline triggers per IP per 10 minutes.
    cronRateLimit: Number.isFinite(Number(env.CRON_RATE_LIMIT)) &&
      Number(env.CRON_RATE_LIMIT) > 0
      ? Number(env.CRON_RATE_LIMIT)
      : 5,
  };
}

/** Origins allowed to call the API cross-origin (dev: vite :5173 -> worker :8787).
 *  Production serves the SPA and API same-origin, so CORS rarely matters there. */
export function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS ?? "";
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length > 0
    ? fromEnv
    : ["http://localhost:5173", "http://localhost:8787"];
}