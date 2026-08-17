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
    const rlEnv = { GEMINI_API_KEY: "", CRON_SECRET: SECRET, CRON_RATE_LIMIT: "1", DB: {} } as unknown as Env;
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

  console.log("== test: GET /api/search ==");
  {
    const r = await api("/api/search?q=assad");
    check("200", r.status === 200);
    check("shape", Array.isArray(r.json?.clusters) && r.json?.query === "assad");
    const seeded = r.json?.clusters.find(
      (c: any) => c.keyPhrase === "Bashar al-Assad sentenced to death"
    );
    check("seeded cluster found via keyPhrase", !!seeded);
    check("full cluster shape (framing + articles)", !!seeded?.framing?.neutralSummary && seeded?.articles?.length === 3);
    check("hasMore false", r.json?.hasMore === false);
    check("cache-control public", r.headers.get("cache-control") === "public, max-age=60");

    const r2 = await api("/api/search?q=trump");
    check(
      "article-title match (keyPhrase differs)",
      r2.json?.clusters.some(
        (c: any) => c.keyPhrase === "Trump media stock plunges after massive loss"
      )
    );

    const r5 = await api("/api/search?q=zzzznothing");
    check("no matches -> empty list", r5.json?.clusters.length === 0);
    const r6 = await api("/api/search?q=50%25");
    check("LIKE metacharacters don't match-all", r6.json?.clusters.length === 0);
  }

  console.log("== test: GET /api/search validation ==");
  {
    const short = await api("/api/search?q=x");
    check("too-short q -> 400", short.status === 400);
    const long = await api(`/api/search?q=${"a".repeat(101)}`);
    check("too-long q -> 400", long.status === 400);
    const empty = await api("/api/search?q=");
    check("empty q -> 400", empty.status === 400);
    const badLimit = await api("/api/search?q=assad&limit=99");
    check("invalid limit -> 400", badLimit.status === 400);
    const zeroLimit = await api("/api/search?q=assad&limit=0");
    check("zero limit -> 400", zeroLimit.status === 400);
  }

  console.log("== test: GET /api/clusters/:id (deep link) ==");
  {
    const list = await api("/api/clusters");
    const first = list.json?.clusters[0];
    const r = await api(`/api/clusters/${first.id}`);
    check("200 for existing id", r.status === 200);
    check("same keyPhrase as list", r.json?.keyPhrase === first.keyPhrase);
    check("articles attached", r.json?.articles?.length === first.articles?.length);
    check("framing attached", !!r.json?.framing?.neutralSummary);
    check("cache-control public", r.headers.get("cache-control") === "public, max-age=60");

    const miss = await api("/api/clusters/999999");
    check("missing -> 404", miss.status === 404);
    const bad = await api("/api/clusters/abc");
    check("non-numeric -> 400", bad.status === 400);
    const huge = await api(`/api/clusters/${"9".repeat(11)}`);
    check("overlong id -> 400", huge.status === 400);
  }

  console.log("== test: GET /api/tone-radar ==");
  {
    const r = await api("/api/tone-radar");
    check("200", r.status === 200);
    check("computedAt present", typeof r.json?.computedAt === "string");
    const outlets = r.json?.outlets ?? [];
    check("6 outlets from seeded framings", outlets.length === 6);
    const bbc = outlets.find((o: any) => o.source === "BBC");
    check("BBC: 3 frames, 2 spun (celebratory x2)", bbc?.frames === 3 && bbc?.spun === 2);
    check("BBC spinRatio 2/3", Math.abs((bbc?.spinRatio ?? 0) - 2 / 3) < 1e-9);
    check("tone counts tracked", bbc?.tones?.celebratory === 2 && bbc?.tones?.neutral === 1);
    const cnn = outlets.find((o: any) => o.source === "CNN");
    check("analytical-only outlet not spun", cnn?.frames === 1 && cnn?.spun === 0);
    check("sorted by spinRatio desc", outlets[0].source === "BBC");
  }

  console.log("== test: GET /api/tone-radar?category= ==");
  {
    const r = await api("/api/tone-radar?category=culture-sport");
    check("200", r.status === 200);
    check("category echoed", r.json?.category === "culture-sport");
    const sport = r.json?.outlets ?? [];
    check("only culture-sport outlets (AP+BBC, no CNN)", sport.length === 2 && !sport.some((o: any) => o.source === "CNN"));
    const ap = sport.find((o: any) => o.source === "AP");
    check("AP: 2 frames, 1 spun (world-cup frame is neutral)", ap?.frames === 2 && ap?.spun === 1 && ap?.tones?.neutral === 1);

    const crime = await api("/api/tone-radar?category=crime-justice");
    const crimeOutlets = crime.json?.outlets ?? [];
    check("crime-justice: 3 outlets", crimeOutlets.length === 3);
    const bbc = crimeOutlets.find((o: any) => o.source === "BBC");
    check("BBC there: 1 neutral frame, not spun", bbc?.frames === 1 && bbc?.spun === 0);

    const world = await api("/api/tone-radar?category=world");
    check("empty category -> empty list", world.json?.outlets?.length === 0 && world.status === 200);
    const bogus = await api("/api/tone-radar?category=bogus");
    check("invalid category -> 400", bogus.status === 400);
  }

  console.log("== test: GET /api/outlets/:name ==");
  {
    const bbc = await api("/api/outlets/BBC");
    check("200", bbc.status === 200);
    check("BBC covered in 3 clusters", bbc.json?.clusters?.length === 3);
    check("full cluster shape", bbc.json?.clusters?.every((c: any) => Array.isArray(c.articles)));
    check("stat: 3 frames, 2 spun", bbc.json?.stat?.frames === 3 && bbc.json?.stat?.spun === 2);
    check("spinRatio 2/3", Math.abs((bbc.json?.stat?.spinRatio ?? 0) - 2 / 3) < 1e-9);
    check("tones tracked", bbc.json?.stat?.tones?.celebratory === 2 && bbc.json?.stat?.tones?.neutral === 1);

    const reuters = await api("/api/outlets/Reuters");
    check("Reuters in 2 clusters, 0 spun", reuters.json?.clusters?.length === 2 && reuters.json?.stat?.spun === 0);

    const none = await api("/api/outlets/NonexistentOutlet");
    check("unknown outlet -> empty list + zero stat", none.json?.clusters?.length === 0 && none.json?.stat?.frames === 0 && none.json?.stat?.spinRatio === 0);

    const paged = await api("/api/outlets/BBC?limit=1");
    check("limit honored + hasMore", paged.json?.clusters?.length === 1 && paged.json?.hasMore === true);

    const badLimit = await api("/api/outlets/BBC?limit=99");
    check("invalid limit -> 400", badLimit.status === 400);
    const badName = await api(`/api/outlets/${"x".repeat(101)}`);
    check("overlong name -> 400", badName.status === 400);
    check("cache-control public", bbc.headers.get("cache-control") === "public, max-age=60");
  }

  console.log("== test: GET /story/:id (OG share page) ==");
  {
    const r = await api("/story/1");
    check("200", r.status === 200);
    check("html content type", (r.headers.get("content-type") ?? "").includes("text/html"));
    check("title from keyPhrase", r.text.includes("<title>Bashar al-Assad sentenced to death — The Anti-Spin Read</title>"));
    check("og:title", r.text.includes('property="og:title" content="Bashar al-Assad sentenced to death"'));
    check("og:description from neutralSummary", r.text.includes('property="og:description" content="A Syrian court sentenced Bashar al-Assad to death in absentia over killings and torture committed during his rule."'));
    check("og:image from safe article image", r.text.includes('property="og:image" content="https://picsum.photos/seed/bbc/640/400"'));
    check("twitter large image card", r.text.includes('name="twitter:card" content="summary_large_image"'));
    check("canonical url", r.text.includes('<link rel="canonical" href="http://localhost/story/1">'));
    check("json-ld NewsArticle", r.text.includes('"@type":"NewsArticle"'));
    check("coverage list with links", r.text.includes("Ousted Syrian dictator"));
    check("security headers on html too", !!r.headers.get("content-security-policy"));
    check("long cache", r.headers.get("cache-control") === "public, max-age=3600");

    const miss = await api("/story/999999");
    check("purged -> 404 noindex page", miss.status === 404 && miss.text.includes("no longer available"));
    const bad = await api("/story/abc");
    check("non-numeric -> 404 page", bad.status === 404);
  }

  console.log("== test: GET /story/:id escaping (feed-injected markup) ==");
  {
    const escDb = new MemoryDb();
    const escApp = createApp(escDb);
    const escEnv = { GEMINI_API_KEY: "", CRON_SECRET: SECRET, DB: {} } as Env;
    await escDb.insertArticles([
      {
        dedupKey: "esc|BBC|1",
        source: "BBC",
        title: "<b>Bold</b> & \"quote\"",
        url: "https://bbc.example/x",
        lede: "lede & more",
        publishedAt: new Date(),
        imageUrl: "",
      },
    ]);
    const id = await escDb.createCluster(
      `<script>alert(1)</script> & "quoted"`,
      ["esc|BBC|1"],
      new Date(),
      "esc-sig"
    );
    const res = await escApp.request(`/story/${id}`, {}, escEnv);
    const text = await res.text();
    check("200", res.status === 200);
    check("script tag cannot break out (html)", !text.includes("<script>alert(1)</script>") && text.includes("&lt;script&gt;"));
    check("script tag cannot break out (json-ld)", !text.includes('"headline":"<script>alert(1)</script>'));
    check("ampersand escaped", text.includes("&amp;"));
    check("quote escaped", text.includes("&quot;"));
  }

  console.log("== test: robots.txt + sitemap.xml ==");
  {
    const robots = await api("/robots.txt");
    check("200 text", robots.status === 200 && (robots.headers.get("content-type") ?? "").includes("text/plain"));
    check("allow all, disallow api", robots.text.includes("Allow: /") && robots.text.includes("Disallow: /api/"));
    check("sitemap absolute url", robots.text.includes("Sitemap: http://localhost/sitemap.xml"));

    const sitemap = await api("/sitemap.xml");
    check("200 xml", sitemap.status === 200 && (sitemap.headers.get("content-type") ?? "").includes("application/xml"));
    check("urlset root", sitemap.text.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
    // 5 seeded + 1 "Broken cluster" added by the sanitization test above.
    check("all 6 clusters listed", (sitemap.text.match(/<url>/g) ?? []).length === 6);
    check("loc points at story pages", sitemap.text.includes("<loc>http://localhost/story/1</loc>"));
    check("lastmod present", sitemap.text.includes("<lastmod>"));
    check("long cache", sitemap.headers.get("cache-control") === "public, max-age=21600");
    check("security headers on xml too", !!sitemap.headers.get("content-security-policy"));
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
  const body = (await res.json()) as { runs: any[]; backlog: number };
  check("200", res.status === 200);
  check("runs newest first", body.runs[0].scraped === 80 && body.runs[1].scraped === 100);
  check("no-store cache", res.headers.get("cache-control") === "no-store");
  check("error surfaced", body.runs[0].error === "Gemini HTTP 500");
  // Unframed cluster -> the framing backlog is surfaced to the SPA footer.
  await runsDb.insertArticles([
    {
      dedupKey: "seed|BBC|Unframed",
      source: "BBC",
      title: "Unframed story",
      url: "https://bbc.example/unframed",
      lede: "",
      publishedAt: new Date(),
      imageUrl: "",
    },
  ]);
  await runsDb.createCluster("Unframed cluster", ["seed|BBC|Unframed"], new Date(), "unframed-sig");
  const res2 = await runsApp.request("/api/runs", {}, runsEnv);
  const body2 = (await res2.json()) as { backlog: number };
  check("backlog counts unframed clusters", body2.backlog === 1);
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