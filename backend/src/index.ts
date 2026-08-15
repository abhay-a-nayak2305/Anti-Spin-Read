import { Hono } from "hono";
import type {
  ExecutionContext,
  ExportedHandler,
  ScheduledController,
} from "@cloudflare/workers-types";
import { D1Db } from "./db.js";
import { runPipeline } from "./pipeline.js";
import { workerConfig, allowedOrigins } from "./config.js";
import { categorizeCluster } from "./categorize.js";
import { isSafeHttpUrl } from "./images.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import type { Db } from "./db.js";
import type { Env } from "./types.js";

const RATE_WINDOW_MS = 10 * 60_000;

/**
 * Constant-time string compare (no early exit on byte mismatch).
 * Manual XOR accumulation: crypto.subtle.timingSafeEqual is not part of
 * the WebCrypto spec, so it exists in neither Workers nor Node.
 * Length is compared separately (lengths are not secret).
 */
function secretsEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/** Security headers for API + SPA responses (CSP fits the Vite/Tailwind/Google-Fonts stack). */
function applySecurityHeaders(headers: Headers): void {
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
}

/**
 * The app factory. `db` is injected by tests / the seeded UI server;
 * the deployed Worker builds a D1-backed Db from its binding per request.
 */
export function createApp(db?: Db) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { requestId: string };
  }>();

  /** Injected db (tests / seeded UI server) or the deployed D1-backed Db */
  const resolveDb = (env: Env): Db => db ?? new D1Db(env.DB);

  // Per-rate-limit-value limiter state, isolated per app instance (tests
  // create fresh apps). Sliding window per IP over 10 minutes.
  const limiters = new Map<
    number,
    ReturnType<typeof createSlidingWindowLimiter>
  >();

  // Logging (structured JSON, request-scoped id) + security headers +
  // per-origin CORS (env-dependent, so set manually instead of hono's
  // env-less cors() middleware).
  app.use("*", async (c, next) => {
    const start = Date.now();
    const requestId = crypto.randomUUID().slice(0, 8);
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    try {
      await next();
    } catch (err) {
      // Fallback when a route throws before Hono's onError can run
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          requestId,
          method: c.req.method,
          path: c.req.path,
          err: String(err),
        })
      );
      throw err;
    }
    const ms = Date.now() - start;
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    console.log(
      JSON.stringify({
        level: "info",
        ts: new Date().toISOString(),
        requestId,
        ip,
        method: c.req.method,
        // Path only, never the raw query string (URLs in query params
        // can carry sensitive fragments).
        path: c.req.path,
        status: c.res.status,
        ms,
      })
    );

    const headers = c.res.headers;
    const origin = c.req.header("Origin");
    if (origin && allowedOrigins(c.env).includes(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Headers", "x-cron-secret, content-type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    applySecurityHeaders(headers);
  });

  // Any unhandled error -> JSON 500 with the request id for correlation,
  // never a stack trace (defense in depth on top of per-route try/catch).
  app.onError((err, c) => {
    console.error(
      JSON.stringify({
        level: "error",
        ts: new Date().toISOString(),
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        err: String(err),
      })
    );
    return c.json({ error: "internal error" }, 500);
  });

  // Preflight support for the dev setup (vite :5173 -> worker :8787)
  app.options("*", (c) => c.body(null, 204));

  // Health check — liveness for uptime monitors
  app.get("/api/health", (c) => {
    return c.json({ ok: true, time: new Date().toISOString() });
  });

  // Manual pipeline trigger (the Cron Trigger is the automatic path).
  // Fail-closed secret auth (no default), constant-time compare, per-IP
  // rate limiting; the pipeline's D1 lock prevents overlapping runs.
  app.post("/api/cron", async (c) => {
    const cfg = workerConfig(c.env);
    if (!cfg.cronSecret) {
      return c.json({ error: "cron not configured" }, 503);
    }
    const secret = c.req.header("x-cron-secret") ?? "";
    if (!secretsEqual(secret, cfg.cronSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    let limiter = limiters.get(cfg.cronRateLimit);
    if (!limiter) {
      limiter = createSlidingWindowLimiter(cfg.cronRateLimit, RATE_WINDOW_MS);
      limiters.set(cfg.cronRateLimit, limiter);
    }
    const decision = limiter.allow(ip);
    c.header("X-RateLimit-Limit", String(cfg.cronRateLimit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      c.header("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
      return c.json({ error: "rate limited" }, 429);
    }
    try {
      const result = await runPipeline(c.env, resolveDb(c.env));
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error("[cron] pipeline failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Public read API: clusters with framing, newest first.
  // Pagination: ?limit= (1..50, default 50) and ?offset= (default 0),
  // plus hasMore so clients know when to stop fetching.
  // Edge-cached via the Workers Cache API (60s) keyed on the full URL —
  // serves the free tier by cutting D1 reads on repeat/other-isolate hits.
  app.get("/api/clusters", async (c) => {
    try {
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const rawOffset = Number(c.req.query("offset") ?? "0");
      // Strict validation: non-numeric / out-of-range params are rejected
      // outright rather than silently clamped (fail loudly in dev).
      const limit =
        Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50
          ? rawLimit
          : null;
      const offset =
        Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 10_000
          ? rawOffset
          : null;
      if (limit === null || offset === null) {
        return c.json({ error: "invalid limit/offset" }, 400);
      }
      const cache = typeof caches !== "undefined" ? caches.default : null;
      const cacheKey = new Request(c.req.url);
      if (cache) {
        const hit = await cache.match(cacheKey).catch(() => null);
        if (hit) {
          // Copy to a mutable Response so the middleware can re-apply
          // security headers + per-origin CORS on the cached body.
          return new Response(hit.body, {
            status: hit.status,
            headers: hit.headers,
          });
        }
      }
      // Fetch one extra row to report hasMore without a count query.
      const db = resolveDb(c.env);
      const rows = await db.latestClusters(limit + 1, offset);
      const hasMore = rows.length > limit;
      const clusters = rows.slice(0, limit);
      c.header("Cache-Control", "public, max-age=60");
      const res = c.json({
        limit,
        offset,
        hasMore,
        clusters: clusters.map((cl) => ({
          id: cl.id,
          keyPhrase: cl.keyPhrase,
          category: categorizeCluster(cl),
          seenAt: cl.seenAt.toISOString(),
          framedAt: cl.framedAt ? cl.framedAt.toISOString() : null,
          // Details stay in D1 for the operator; clients get a generic label
          framingError: cl.framingError ? "Framing failed" : null,
          framing: cl.framing,
          articles: cl.articles.map((a) => ({
            source: a.source,
            title: a.title,
            // Defense in depth: never serve non-http(s) URLs from feed data
            url: isSafeHttpUrl(a.url) ? a.url : "",
            lede: a.lede,
            publishedAt: a.publishedAt.toISOString(),
            imageUrl: isSafeHttpUrl(a.imageUrl) ? a.imageUrl : "",
          })),
        })),
      });
      if (cache) {
        c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
      }
      return res;
    } catch (err) {
      console.error("[api] clusters failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Ops endpoint: recent pipeline runs from the event log (newest first).
  // Not cached — operators want fresh state.
  app.get("/api/runs", async (c) => {
    try {
      const rawLimit = Number(c.req.query("limit") ?? "10");
      const limit =
        Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 20
          ? rawLimit
          : null;
      if (limit === null) {
        return c.json({ error: "invalid limit" }, 400);
      }
      const runs = await resolveDb(c.env).latestPipelineRuns(limit);
      c.header("Cache-Control", "no-store");
      return c.json({
        runs: runs.map((r) => ({
          id: r.id,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt.toISOString(),
          scraped: r.scraped,
          newArticles: r.newArticles,
          clusters: r.clusters,
          framed: r.framed,
          failed: r.failed,
          skipped: r.skipped,
          error: r.error,
        })),
      });
    } catch (err) {
      console.error("[api] runs failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Everything else: serve the built SPA from the ASSETS binding.
  // API misses keep returning JSON 404s.
  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not found" }, 404);
    }
    if (c.env.ASSETS) {
      const res = await c.env.ASSETS.fetch(c.req.raw);
      if (res.status === 404) {
        const index = await c.env.ASSETS.fetch(
          new Request(new URL("/index.html", c.req.url))
        );
        if (index.ok) {
          return new Response(index.body, {
            status: 200,
            // The SPA shell must never be cached: deploys change it.
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
          });
        }
        // Copy into a mutable Response so the security-header middleware
        // (applySecurityHeaders) can set CSP/nosniff etc. — ASSETS.fetch
        // responses carry immutable headers.
        return new Response(res.body, { status: res.status, headers: res.headers });
      }
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    return c.text("not found", 404);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  // Runs the pipeline every 15 minutes (see [triggers] in wrangler.jsonc) —
  // replaces the old GitHub Actions cron.
  scheduled: async (_controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    try {
      const result = await runPipeline(env, new D1Db(env.DB));
      console.log(`[scheduled] pipeline: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error("[scheduled] pipeline failed:", err);
    }
  },
} as ExportedHandler<Env>;