import { Hono } from "hono";
import type {
  ExecutionContext,
  ExportedHandler,
  ScheduledController,
} from "@cloudflare/workers-types";
import { D1Db } from "./db.js";
import { runPipeline } from "./pipeline.js";
import { workerConfig, allowedOrigins, FRAMING_CRON_SCHEDULE } from "./config.js";
import { categorizeCluster } from "./categorize.js";
import { isSafeHttpUrl } from "./images.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import type { Db } from "./db.js";
import type { ClusterRecord, Env } from "./types.js";

const RATE_WINDOW_MS = 10 * 60_000;

/** Sitemap caps at 10k URLs (14-day retention keeps the real count far lower). */
const SITEMAP_MAX = 10_000;

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

/** Map a ClusterRecord to the public API shape (SSRF re-check on serve). */
function toApiCluster(cl: ClusterRecord) {
  return {
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
  };
}

/** Escape text for embedding in HTML/XML (OG page, sitemap). */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}



/** Best available one-line description for a cluster (OG meta). */
function ogDescription(cl: ClusterRecord): string {
  if (cl.framing?.neutralSummary) return cl.framing.neutralSummary;
  const lede = cl.articles.find((a) => a.lede.trim());
  if (lede) return lede.lede;
  return cl.keyPhrase;
}

/** Small noindex page for purged/invalid story links (crawler-safe 404). */
function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Story not found — The Anti-Spin Read</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:2rem 1rem;color:#222;background:#fdfdfb}a{color:#0a5c46}</style>
</head>
<body>
<p><a href="/">← The Anti-Spin Read</a></p>
<h1>This story link is no longer available</h1>
<p>Stories are pruned after 14 days — try the homepage for current coverage.</p>
</body>
</html>`;
}

/** Edge-cache read: hit -> a mutable copy of the cached Response, else null. */
async function edgeCacheHit(reqUrl: string): Promise<Response | null> {
  if (typeof caches === "undefined") return null;
  const cacheKey = new Request(reqUrl);
  const hit = await caches.default.match(cacheKey).catch(() => null);
  if (hit) {
    // Copy to a mutable Response so the middleware can re-apply
    // security headers + per-origin CORS on the cached body.
    return new Response(hit.body, { status: hit.status, headers: hit.headers });
  }
  return null;
}

/**
 * Edge-cache write (body is cloned; the caller's Response stays usable).
 * Returns null when the Cache API is unavailable (tests/Node) — callers
 * must skip executionCtx.waitUntil in that case, since the test harness
 * has no ExecutionContext at all.
 */
function edgeCachePut(reqUrl: string, res: Response): Promise<void> | null {
  if (typeof caches === "undefined") return null;
  const cacheKey = new Request(reqUrl);
  return caches.default.put(cacheKey, res.clone()).catch(() => {});
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
      const cached = await edgeCacheHit(c.req.url);
      if (cached) return cached;
      // Fetch one extra row to report hasMore without a count query.
      const rows = await resolveDb(c.env).latestClusters(limit + 1, offset);
      const hasMore = rows.length > limit;
      c.header("Cache-Control", "public, max-age=60");
      const res = c.json({
        limit,
        offset,
        hasMore,
        clusters: rows.slice(0, limit).map(toApiCluster),
      });
      const put = edgeCachePut(c.req.url, res);
      if (put) c.executionCtx.waitUntil(put);
      return res;
    } catch (err) {
      console.error("[api] clusters failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Search: clusters whose key phrase or any article title/lede contains q
  // (case-insensitive substring). Plain LIKE over a small table — no FTS5,
  // no migration, no cost.
  app.get("/api/search", async (c) => {
    try {
      const rawQ = (c.req.query("q") ?? "").trim();
      if (rawQ.length < 2 || rawQ.length > 100) {
        return c.json({ error: "invalid q (2-100 chars)" }, 400);
      }
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const limit =
        Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50
          ? rawLimit
          : null;
      if (limit === null) {
        return c.json({ error: "invalid limit" }, 400);
      }
      const cached = await edgeCacheHit(c.req.url);
      if (cached) return cached;
      const rows = await resolveDb(c.env).searchClusters(rawQ, limit + 1);
      const hasMore = rows.length > limit;
      c.header("Cache-Control", "public, max-age=60");
      const res = c.json({
        query: rawQ,
        limit,
        hasMore,
        clusters: rows.slice(0, limit).map(toApiCluster),
      });
      const put = edgeCachePut(c.req.url, res);
      if (put) c.executionCtx.waitUntil(put);
      return res;
    } catch (err) {
      console.error("[api] search failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Single cluster by numeric id — powers shareable deep links (#/story/:id).
  // 404 (uncached) when purged: a dead link is honest, not a redirect loop.
  app.get("/api/clusters/:id", async (c) => {
    try {
      const rawId = c.req.param("id");
      if (!/^\d{1,10}$/.test(rawId)) {
        return c.json({ error: "invalid id" }, 400);
      }
      const cached = await edgeCacheHit(c.req.url);
      if (cached) return cached;
      const row = await resolveDb(c.env).clusterById(rawId);
      if (!row) {
        return c.json({ error: "not found" }, 404);
      }
      c.header("Cache-Control", "public, max-age=60");
      const res = c.json(toApiCluster(row));
      const put = edgeCachePut(c.req.url, res);
      if (put) c.executionCtx.waitUntil(put);
      return res;
    } catch (err) {
      console.error("[api] cluster failed:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Server-rendered share page: crawlers (X, WhatsApp, Slack) ignore URL
  // hashes, so #/story/<id> links open blank there. /story/<id> is the
  // crawlable twin: minimal HTML + OpenGraph/Twitter tags + JSON-LD, built
  // from D1 alone (no LLM call), long edge-cached. Crawlers don't enforce
  // the SPA CSP, so the inline JSON-LD script is safe for them.
  app.get("/story/:id", async (c) => {
    try {
      const rawId = c.req.param("id");
      if (!/^\d{1,10}$/.test(rawId)) {
        return c.html(notFoundPage(), 404);
      }
      const cached = await edgeCacheHit(c.req.url);
      if (cached) return cached;
      const row = await resolveDb(c.env).clusterById(rawId);
      if (!row) {
        return c.html(notFoundPage(), 404);
      }
      const origin = new URL(c.req.url).origin;
      const url = `${origin}/story/${rawId}`;
      const title = row.keyPhrase;
      const description = ogDescription(row).slice(0, 300);
      const image =
        row.articles.find((a) => a.imageUrl && isSafeHttpUrl(a.imageUrl))
          ?.imageUrl ?? null;
      const seenIso = row.seenAt.toISOString();
      const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} — The Anti-Spin Read</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="The Anti-Spin Read">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "NewsArticle",
  headline: title,
  description,
  url,
  image: image ? [image] : undefined,
  datePublished: seenIso,
  dateModified: row.framedAt?.toISOString() ?? seenIso,
  publisher: { "@type": "Organization", name: "The Anti-Spin Read" },
})
  // Feed titles are untrusted: `</script>` inside the JSON would close the
  // tag in the HTML parser. JSON.stringify doesn't escape `<`/`>`, so the
  // JSON-LD payload is hardened with explicit unicode escapes.
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")}
</script>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:0 auto;padding:2rem 1rem;color:#222;background:#fdfdfb}a{color:#0a5c46}h1{font-size:1.6rem;line-height:1.25}time{color:#666;font-size:.85rem}p{line-height:1.55}ul{padding-left:1.2rem}</style>
</head>
<body>
<main>
  <p><a href="/">← The Anti-Spin Read</a></p>
  <h1>${esc(title)}</h1>
  <p><time datetime="${esc(seenIso)}">${esc(seenIso)}</time>
    ${row.framedAt ? `· <time datetime="${esc(row.framedAt.toISOString())}">framed ${esc(row.framedAt.toISOString())}</time>` : ""}
    · ${row.articles.length} ${row.articles.length === 1 ? "outlet" : "outlets"} covered</p>
  ${description ? `<p>${esc(description)}</p>` : ""}
  <h2>Coverage</h2>
  <ul>
${row.articles
  .map(
    (a) =>
      `    <li><strong>${esc(a.source)}</strong> — <a href="${esc(a.url && isSafeHttpUrl(a.url) ? a.url : "")}" rel="noopener">${esc(a.title)}</a></li>`
  )
  .join("\n")}
  </ul>
</main>
</body>
</html>`;
      c.header("Cache-Control", "public, max-age=3600");
      const res = c.html(page);
      const put = edgeCachePut(c.req.url, res);
      if (put) c.executionCtx.waitUntil(put);
      return res;
    } catch (err) {
      console.error("[story] page failed:", err);
      return c.html(notFoundPage(), 404);
    }
  });

  // SEO / crawler plumbing.
  app.get("/robots.txt", async (c) => {
    const origin = new URL(c.req.url).origin;
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(
      `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`
    );
  });

  app.get("/sitemap.xml", async (c) => {
    try {
      const cached = await edgeCacheHit(c.req.url);
      if (cached) return cached;
      const origin = new URL(c.req.url).origin;
      const rows = await resolveDb(c.env).sitemapMeta(SITEMAP_MAX);
      const urls = rows
        .map((r) => {
          const lastmod = r.seenAt.toISOString().slice(0, 10);
          return `  <url><loc>${esc(origin)}/story/${esc(r.id)}</loc><lastmod>${lastmod}</lastmod></url>`;
        })
        .join("\n");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
      c.header("Cache-Control", "public, max-age=21600");
      const res = c.body(xml, 200, {
        "Content-Type": "application/xml; charset=utf-8",
      });
      const put = edgeCachePut(c.req.url, res);
      if (put) c.executionCtx.waitUntil(put);
      return res;
    } catch (err) {
      console.error("[sitemap] failed:", err);
      return c.text("", 500);
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
  // Two cron triggers (see [triggers] in wrangler.jsonc):
  //   */15 * * * *       — full pipeline (scrape -> cluster -> frame)
  //   FRAMING_CRON_SCHEDULE — framing-only: drains the unframed retry queue
  //                        (up to FRAMING_ONLY_BATCH per run) without
  //                        spending subrequests on RSS/enrichment, so the
  //                        backlog never lingers. Idle when the queue is empty.
  scheduled: async (controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    const framingOnly = controller.cron === FRAMING_CRON_SCHEDULE;
    try {
      const result = await runPipeline(env, new D1Db(env.DB), { framingOnly });
      console.log(`[scheduled]${framingOnly ? " framing-only" : ""} pipeline: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[scheduled]${framingOnly ? " framing-only" : ""} pipeline failed:`, err);
    }
  },
} as ExportedHandler<Env>;
