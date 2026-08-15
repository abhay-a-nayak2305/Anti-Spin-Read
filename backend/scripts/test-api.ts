import { createApp } from "../src/index.js";
import { MemoryDb } from "../src/db-memory.js";
import { seedFixtures } from "./seed-fixtures.js";
import { hashText } from "../src/scraper.js";
import type { Env } from "../src/types.js";

// API integration tests: the real Hono app with an in-memory Db,
// exercised over HTTP through app.request(). Seeded data so
// /api/clusters has content; security + robustness cases included.

let passed = 0;
let failed = 0;
const SECRET = "test-secret-123";

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const db = new MemoryDb();
  await seedFixtures(db);
  const app = createApp(db);
  const env = { GEMINI_API_KEY: "", CRON_SECRET: SECRET, DB: {} } as Env;

  async function api(
    path: string,
    opts: { method?: string; secret?: string; origin?: string } = {}
  ): Promise<{ status: number; json: any; text: string; headers: Headers }> {
    const res = await app.request(
      path,
      {
        method: opts.method ?? "GET",
        headers: {
          ...(opts.secret ? { "x-cron-secret": opts.secret } : {}),
          ...(opts.origin ? { Origin: opts.origin } : {}),
        },
      },
      env
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }

  console.log("== test: GET /api/health ==");
  {
    const r = await api("/api/health");
    check("200", r.status === 200);
    check("ok:true", r.json?.ok === true);
  }

  console.log("== test: security headers on every response ==");
  {
    const r = await api("/api/health");
    check("CSP present", !!r.headers.get("content-security-policy"), r.headers.get("content-security-policy") ?? "");
    check("nosniff present", r.headers.get("x-content-type-options") === "nosniff");
    check("XFO DENY", r.headers.get("x-frame-options") === "DENY");
    check("referrer-policy no-referrer", r.headers.get("referrer-policy") === "no-referrer");
  }

  console.log("== test: POST /api/cron auth (fail-closed + timing-safe) ==");
  {
    const noSecret = await api("/api/cron", { method: "POST" });
    check("401 without secret", noSecret.status === 401);
    const badSecret = await api("/api/cron", { method: "POST", secret: "wrong" });
    check("401 with wrong secret", badSecret.status === 401);
    const shortSecret = await api("/api/cron", { method: "POST", secret: "x" });
    check("401 with wrong-length secret (no length oracle)", shortSecret.status === 401);
  }

  console.log("== test: POST /api/cron 503 when secret unset (fail-closed) ==");
  {
    const bare = createApp(new MemoryDb());
    const res = await bare.request(
      "/api/cron",
      { method: "POST", headers: { "x-cron-secret": SECRET } },
      { GEMINI_API_KEY: "", CRON_SECRET: undefined, DB: {} } as unknown as Env
    );
    const body = (await res.json()) as { error?: string };
    check("503 not configured", res.status === 503 && body.error === "cron not configured");
    check("no generic 500 leaks", res.status !== 500);
  }

  console.log("== test: POST /api/cron rate limited per IP ==");
  {
    const rlDb = new MemoryDb();
    await seedFixtures(rlDb);
    const rlApp = createApp(rlDb);
    const rlEnv = { GEMINI_API_KEY: "", CRON_SECRET: SECRET, CRON_RATE_LIMIT: "1", DB: {} } as Env;
    const first = await rlApp.request(
      "/api/cron",
      { method: "POST", headers: { "x-cron-secret": SECRET, "cf-connecting-ip": "1.2.3.4" } },
      rlEnv
    );
    const second = await rlApp.request(
      "/api/cron",
      { method: "POST", headers: { "x-cron-secret": SECRET, "cf-connecting-ip": "1.2.3.4" } },
      rlEnv
    );
    check("first call accepted", first.status === 200, `status ${first.status}`);
    check("second call 429", second.status === 429);
    check("X-RateLimit-Limit header", first.headers.get("x-ratelimit-limit") === "1");
    check("X-RateLimit-Remaining header on 429", second.headers.get("x-ratelimit-remaining") === "0");
    check("Retry-After on 429", !!second.headers.get("retry-after"));
    const other = await rlApp.request(
      "/api/cron",
      { method: "POST", headers: { "x-cron-secret": SECRET, "cf-connecting-ip": "9.9.9.9" } },
      rlEnv
    );
    check("different IP not limited", other.status === 200);
  }

  console.log("== test: X-Request-Id correlation header ==");
  {
    const r = await api("/api/health");
    check("request id present", /^[0-9a-f]{8}$/.test(r.headers.get("x-request-id") ?? ""));
  }

  console.log("== test: GET /api/clusters pagination ==");
  {
    const page1 = await api("/api/clusters?limit=2&offset=0");
    check("200", page1.status === 200);
    check("exactly 2 clusters", page1.json?.clusters?.length === 2);
    check("hasMore true", page1.json?.hasMore === true);
    check("limit/offset echoed", page1.json?.limit === 2 && page1.json?.offset === 0);
    const page2 = await api("/api/clusters?limit=2&offset=2");
    check("second page different clusters", page2.json?.clusters?.[0]?.id !== page1.json?.clusters?.[0]?.id);
    const beyond = await api("/api/clusters?limit=2&offset=999");
    check("empty page hasMore false", beyond.json?.clusters?.length === 0 && beyond.json?.hasMore === false);
  }

  console.log("== test: GET /api/clusters param validation ==");
  {
    const bad1 = await api("/api/clusters?limit=0");
    check("limit=0 -> 400", bad1.status === 400);
    const bad2 = await api("/api/clusters?limit=100");
    check("limit=100 -> 400", bad2.status === 400);
    const bad3 = await api("/api/clusters?limit=abc");
    check("limit=abc -> 400", bad3.status === 400);
    const bad4 = await api("/api/clusters?offset=-5");
    check("offset=-5 -> 400", bad4.status === 400);
    const good = await api("/api/clusters?limit=1");
    check("valid param accepted", good.status === 200 && good.json?.clusters?.length === 1);
  }

  console.log("== test: ASSETS SPA fallback + mutable security headers ==");
  {
    // Regression test for the immutable-headers bug: ASSETS.fetch returns
    // frozen Headers; every response must still carry CSP/nosniff.
    const spaApp = createApp(new MemoryDb());
    const assetsEnv = {
      GEMINI_API_KEY: "",
      CRON_SECRET: SECRET,
      DB: {},
      ASSETS: {
        fetch: async (req: Request) =>
          new Response("<html><body>SPA shell</body></html>", {
            status: req.url.includes("/index.html") ? 200 : 404,
            headers: { "Content-Type": "text/html" },
          }),
      },
    } as unknown as Env;
    const spa = await spaApp.request("/", {}, assetsEnv);
    check("SPA served", spa.status === 200 && (await spa.text()).includes("SPA shell"));
    check("SPA CSP applied (mutable copy)", spa.headers.get("content-security-policy")?.includes("default-src 'self'") === true);
    check("SPA nosniff applied", spa.headers.get("x-content-type-options") === "nosniff");
    check("SPA Cache-Control no-cache", spa.headers.get("cache-control") === "no-cache");
    const api404 = await spaApp.request("/api/nope", {}, assetsEnv);
    check("API miss stays JSON 404 with ASSETS present", api404.status === 404);
    const api404Json = (await api404.json()) as { error?: string };
    check("API 404 is JSON", api404Json.error === "not found");
  }

  console.log("== test: GET /api/clusters shape + cache + sanitization ==");
  {
    const r = await api("/api/clusters");
    check("200", r.status === 200);
    check("Cache-Control public", r.headers.get("cache-control") === "public, max-age=60");
    check("clusters array present", Array.isArray(r.json?.clusters));
    const seeded = r.json?.clusters.find((c: any) => c.keyPhrase === "Bashar al-Assad sentenced to death");
    check("seeded cluster returned", !!seeded);
    check("framing object included", seeded?.framing?.neutralSummary?.includes("Assad"));
    check("articles joined with source+title", seeded?.articles?.length === 3);
    check("no leaking of internal ids", !seeded?.articleKeys && !seeded?._id);

    // framingError -> generic label only (no Gemini internals)
    const bad = await db.createCluster(
      "Broken cluster",
      ["SEED|bad1", "SEED|bad2"],
      new Date(),
      hashText(["SEED|bad1", "SEED|bad2"].sort().join("|"))
    );
    await db.saveFraming(bad, null, null, "Gemini HTTP 500: upstream failure details");
    const r2 = await api("/api/clusters");
    const broken = r2.json?.clusters.find((c: any) => c.keyPhrase === "Broken cluster");
    check("framingError sanitized to generic label", broken?.framingError === "Framing failed");
    check("framing null when failed", broken?.framing === null);

    // dangerous urls sanitized to ""
    await db.insertArticles([
      {
        dedupKey: "SEED|bad1",
        source: "Evil",
        title: "Bad one",
        url: "javascript:alert(1)",
        lede: "x",
        publishedAt: new Date(),
        imageUrl: "data:text/html,<script>alert(1)</script>",
      },
      {
        dedupKey: "SEED|bad2",
        source: "Evil",
        title: "Bad two",
        url: "http://192.168.1.1/admin",
        lede: "x",
        publishedAt: new Date(),
        imageUrl: "http://127.0.0.1/steal",
      },
    ]);
    const r3 = await api("/api/clusters");
    const sanitized = r3.json?.clusters.find((c: any) => c.keyPhrase === "Broken cluster");
    check("javascript: url -> empty", sanitized?.articles?.every((a: any) => a.url === ""));
    check("private-network urls -> empty", sanitized?.articles?.every((a: any) => a.imageUrl === ""));
  }

  console.log("== test: CORS allowlist ==");
  {
    const r = await api("/api/clusters", { origin: "http://localhost:5173" });
    check("dev origin allowed", r.headers.get("access-control-allow-origin") === "http://localhost:5173");
    const blocked = await api("/api/clusters", { origin: "https://evil.example" });
    check("evil origin blocked", blocked.headers.get("access-control-allow-origin") === null);
  }

  console.log("== test: OPTIONS preflight ==");
  {
    const res = await app.request(
      "/api/clusters",
      { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } },
      env
    );
    check("204", res.status === 204);
    check("ACAO echoes allowed origin", res.headers.get("access-control-allow-origin") === "http://localhost:5173");
  }

  console.log("== test: GET /api/runs event log endpoint ==");
{
  const runsDb = new MemoryDb();
  await seedFixtures(runsDb);
  const runsApp = createApp(runsDb);
  const runsEnv = { GEMINI_API_KEY: "", CRON_SECRET: SECRET, DB: {} } as Env;
  await runsDb.recordPipelineRun({
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 119_000),
    scraped: 100,
    newArticles: 20,
    clusters: 3,
    framed: 3,
    failed: 0,
    skipped: 0,
    error: null,
  });
  await runsDb.recordPipelineRun({
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 59_000),
    scraped: 80,
    newArticles: 5,
    clusters: 1,
    framed: 0,
    failed: 1,
    skipped: 0,
    error: "Gemini HTTP 500",
  });
  const res = await runsApp.request("/api/runs", {}, runsEnv);
  const body = (await res.json()) as { runs: any[] };
  check("200", res.status === 200);
  check("runs newest first", body.runs[0].scraped === 80 && body.runs[1].scraped === 100);
  check("no-store cache", res.headers.get("cache-control") === "no-store");
  check("error surfaced", body.runs[0].error === "Gemini HTTP 500");
  const bad = await runsApp.request("/api/runs?limit=99", {}, runsEnv);
  check("invalid limit -> 400", bad.status === 400);
}

console.log("== test: unknown route ==");
  {
    const r = await api("/api/nope");
    check("404 for unknown api route", r.status === 404);
  }

  console.log("\n=====================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("== FAIL ==", err);
  process.exit(1);
});