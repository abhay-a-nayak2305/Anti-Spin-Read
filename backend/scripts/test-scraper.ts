import { scrapeAll, stripOutletSuffix, hashText } from "../src/scraper.js";
import { sources } from "../src/config.js";

// Scraper unit tests with a stubbed fetch: feed validation, title/lede
// cleanup (incl. the "AP News" suffix bug), entity decoding, caps and
// dedup-key stability. No live network.

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Direct RSS feed URLs matching `scraper.ts` `directFeedUrls`.
 * Used by stubFetch to recognize the new direct-feed URLs.
 */
const DIRECT_FEED_URLS: Record<string, string> = {
  "bbc.com": "https://feeds.bbci.co.uk/news/rss.xml",
  "reuters.com": "https://www.reuters.com/rss/?service=rss",
  "cnn.com": "https://rss.cnn.com/rss/edition.rss",
  "npr.org": "https://npr.org/rss/rss.xml",
  "aljazeera.com": "https://www.aljazeera.com/rss",
  "theguardian.com": "https://www.theguardian.com/rss",
  "apnews.com": "https://apnews.com/hub/rss/ap-top-news",
  "thehill.com": "https://thehill.com/rss",
  "france24.com": "https://www.france24.com/en/rss",
  "dw.com": "https://rss.dw.com/rdf/rss-en-world",
  "news.sky.com": "https://feeds.skynews.com/feeds/rss/world.xml",
  "cnbc.com": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "theverge.com": "https://www.theverge.com/rss/index.xml",
  "abcnews.go.com": "https://abcnews.go.com/abcnews/topstories",
  "nbcnews.com": "https://feeds.nbcnews.com/nbcnews/public/news",
  "usatoday.com": "https://rssfeeds.usatoday.com/usatoday-NewsTopStories",
  "independent.co.uk": "https://www.independent.co.uk/rss",
  "politico.com": "https://www.politico.com/rss",
};

function feedXml(items: string): string {
  return `<rss version="2.0"><channel><title>Google News</title><link>https://news.google.com</link><description>d</description>${items}</channel></rss>`;
}

function item(
  title: string,
  link: string,
  pubDate: string,
  description = ""
): string {
  return `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><pubDate>${pubDate}</pubDate><description>${description}</description></item>`;
}

/**
 * Stub fetch with per-source routing: the XML only responds to the feed
 * URL for `label`; every other source gets an empty feed (mirrors reality —
 * each source has its own URL). `status`/`contentType` override the response.
 */
function stubFetch(
  label: string,
  xml: string,
  opts: { status?: number; contentType?: string } = {}
): void {
  const site = sources.find((s) => s.label === label)?.site ?? "";
  const directUrl = DIRECT_FEED_URLS[site] ?? "";
  (globalThis as any).fetch = (url: string) => {
    if (opts.status && opts.status !== 200) {
      return new Response("nope", { status: opts.status });
    }
    const decoded = decodeURIComponent(url);
    const matched = directUrl && decoded.includes(directUrl);
    const body = matched ? xml : feedXml("");
    if (!matched) {
      console.log(`  [stub] no match for ${decoded.substring(0, 80)}... (expected ${directUrl})`);
    }
    return new Response(body, {
      headers: { "content-type": opts.contentType ?? "text/xml; charset=UTF-8" },
    });
  };
}

/** Serve the same (possibly junk) response for every source URL. */
function stubFetchAll(
  handler: (url: string) => Response
): void {
  (globalThis as any).fetch = handler;
}

/** Reset fetch to the original implementation. */
function restoreFetch(): void {
  (globalThis as any).fetch = ORIGINAL_FETCH;
}

console.log("== test: stripOutletSuffix unit cases ==");
{
  check(
    "AP News suffix stripped",
    stripOutletSuffix("Congo outbreak reaches a sixth province AP News", "AP") ===
      "Congo outbreak reaches a sixth province",
    stripOutletSuffix("Congo outbreak reaches a sixth province AP News", "AP")
  );
  check(
    "Al Jazeera English stripped",
    stripOutletSuffix("Story text Al Jazeera English", "Al Jazeera") === "Story text"
  );
  check(
    "label itself stripped",
    stripOutletSuffix("Story text BBC", "BBC") === "Story text"
  );
  check(
    "dash separator tolerated",
    stripOutletSuffix("Story text — The Guardian", "The Guardian") === "Story text"
  );
  check(
    "trailing ellipsis cleaned",
    stripOutletSuffix("Story text The Hill…", "The Hill") === "Story text",
    stripOutletSuffix("Story text The Hill…", "The Hill")
  );
  check(
    "mid-text occurrence untouched",
    stripOutletSuffix("AP News reports the story AP News", "AP") ===
      "AP News reports the story"
  );
}

console.log("== test: title/lede cleanup via live-shaped RSS ==");
{
  stubFetch(
    "BBC",
    feedXml(
      item(
        "Markets rally on rate cut hopes - BBC",
        "https://bbc.example/a",
        "Wed, 14 Aug 2026 10:00:00 GMT",
        "Investors cheered the news BBC"
      )
    )
  );
  const articles = await scrapeAll(48);
  check("one article parsed (others empty)", articles.length === 1);
  if (articles[0]) {
    check("title suffix stripped", articles[0].title === "Markets rally on rate cut hopes");
    check("lede suffix stripped", articles[0].lede === "Investors cheered the news");
    check("source label set", articles[0].source === "BBC");
  }
  restoreFetch();
}

console.log("== test: entity + HTML decoding ==");
{
  stubFetch(
    "Reuters",
    feedXml(
      item(
        "Fed &amp; ECB: &#39;joint&#39; move &quot;announced&quot; &mdash; live - Reuters",
        "https://reuters.example/b",
        "Wed, 14 Aug 2026 11:00:00 GMT",
        "<p>Officials said &lt;no&gt; deal &hellip; Reuters</p>"
      )
    )
  );
  const articles = await scrapeAll(48);
  check("one article parsed", articles.length === 1);
  if (articles[0]) {
    check(
      "title entities decoded",
      articles[0].title === "Fed & ECB: 'joint' move \"announced\" — live",
      articles[0].title
    );
    check(
      "lede tags stripped + entities decoded + truncation ellipsis removed with suffix",
      articles[0].lede === "Officials said <no> deal",
      articles[0].lede
    );
  }
  restoreFetch();
}

console.log("== test: feed validation rejects junk ==");
{
  stubFetchAll(() =>
    new Response("<html><body>error page</body></html>", {
      headers: { "content-type": "text/html" },
    })
  );
  const articles = await scrapeAll(48);
  check("HTML error page -> zero articles (source skipped)", articles.length === 0);
  restoreFetch();

  stubFetchAll(() => new Response("nope", { status: 503 }));
  const articles2 = await scrapeAll(48);
  check("HTTP 503 -> zero articles", articles2.length === 0);
  restoreFetch();
}

console.log("== test: per-feed item cap ==");
{
  const items = Array.from(
    { length: 250 },
    (_, i) =>
      item(
        `Story number ${i} - CNN`,
        `https://cnn.example/${i}`,
        "Wed, 14 Aug 2026 12:00:00 GMT",
        "Lede CNN"
      )
  ).join("");
  stubFetch("CNN", feedXml(items));
  const articles = await scrapeAll(48);
  check("capped at MAX_ITEMS_PER_FEED (200)", articles.length === 200);
  restoreFetch();
}

console.log("== test: dedup keys deterministic ==");
{
  const items = item(
    "Same headline twice - NPR",
    "https://npr.example/x",
    "Wed, 14 Aug 2026 13:00:00 GMT",
    "Lede NPR"
  );
  stubFetch("NPR", feedXml(items));
  const a = await scrapeAll(48);
  const b = await scrapeAll(48);
  restoreFetch();
  check("same article -> same dedup key", a[0]?.dedupKey === b[0]?.dedupKey);
  check("hashText stable", hashText("hello world") === hashText("hello world"));
  check("hashText differs by input", hashText("hello world") !== hashText("hello there"));
}

console.log("== test: missing pubDate falls back to now ==");
{
  stubFetch(
    "The Hill",
    feedXml(
      `<item><title>No date story - The Hill</title><link>https://hill.example/z</link><guid>z</guid></item>`
    )
  );
  const articles = await scrapeAll(48);
  restoreFetch();
  check("article still parsed", articles.length === 1);
  if (articles[0]) {
    const age = Date.now() - articles[0].publishedAt.getTime();
    check("publishedAt ~ now", age >= 0 && age < 60_000);
  }
}

console.log(`\n=====================\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);