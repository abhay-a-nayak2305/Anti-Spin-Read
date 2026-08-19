import Parser from "rss-parser";
import { sources } from "./config.js";
import { isSafeHttpUrl } from "./images.js";
import type { RawArticle } from "./types.js";

const parser = new Parser({ timeout: 15000 });

const FEED_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 2 * 1024 * 1024; // 2 MB — caps worst-case xml2js memory per feed
const MAX_ITEMS_PER_FEED = 200;
const SCRAPE_BATCH = 4; // bound parallel fetches+parses (peak memory + subrequest concurrency)

/** Google News RSS filtered to one outlet's domain — stable, free, no per-site scraping */
function googleNewsFeedUrl(site: string, hours: number): string {
  const q = encodeURIComponent(`when:${hours}h site:${site}`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

const MAX_URL_REDIRECTS = 2;

/**
 * Resolve a Google News redirect URL (news.google.com/rss/articles/…) to
 * the actual article URL by following the Location header chain. Returns
 * the final URL, or the original URL if it doesn't redirect.
 */
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes("news.google.com/rss/articles/")) return url;
  let current = url;
  for (let hop = 0; hop <= MAX_URL_REDIRECTS; hop++) {
    try {
      const res = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || hop === MAX_URL_REDIRECTS) return url;
        current = new URL(location, current).toString();
        continue;
      }
      // Not a redirect — return whatever URL we ended up at
      return res.url || current;
    } catch {
      return url;
    }
  }
  return url;
}

export function hashText(input: string): string {
  // FNV-1a — deterministic 32-bit hash, fine for dedup keys
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&#39;": "'",
  "&apos;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&hellip;": "…",
  "&ndash;": "–",
  "&mdash;": "—",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&#8217;": "'",
  "&#8211;": "–",
  "&#8212;": "—",
};

/** Decode XML/HTML entities (named + numeric) in a string. Shared with the
 *  og:image enrichment path (images.ts) — publishers encode `&` as `&amp;`
 *  inside meta content attributes, and a raw `&amp;` in a stored URL corrupts
 *  its query parameters. */
export function decodeEntities(s: string): string {
  let out = s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(replacement);
  }
  return out;
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best-effort image from a feed item, checked in order:
 * 1. `<img src="…">` inside the raw content (Google News embeds a thumbnail
 *    in the description; URLs are entity-encoded).
 * 2. `<media:content url="…">` (The Hill, Sky News …) — via rss-parser's
 *    namespaced element, attribute in `$`.
 * 3. `<enclosure url="…">`.
 *
 * Only an https/http public URL survives (isSafeHttpUrl) — feed-supplied
 * URLs are untrusted input and must pass the same SSRF gate as og:image
 * URLs. Returns "" when the feed carries no usable image; the pipeline's
 * enrichment (or catch-up) then tries the page's og:image instead.
 */
export function extractFeedImage(item: Record<string, unknown>): string {
  const raw = String(item.content ?? item.contentSnippet ?? "");
  const img = raw.match(/<img[^>]+src=["']([^"']+)["']/i);
  let url = img ? decodeEntities(img[1]) : "";
  if (!url) {
    const mc = item["media:content"];
    const mcFirst = Array.isArray(mc) ? mc[0] : mc;
    const mcUrl = (mcFirst as { $?: { url?: string }; url?: string } | undefined)?.$?.url ??
      (mcFirst as { url?: string } | undefined)?.url;
    if (mcUrl) {
      url = String(mcUrl);
    } else {
      url = String((item.enclosure as { url?: string } | undefined)?.url ?? "");
    }
  }
  return isSafeHttpUrl(url) ? url : "";
}

/** Direct RSS feed URLs for each outlet (official, public RSS endpoints).
 *  These bypass Google News entirely and work from any Cloudflare Worker IP.
 *  Keys match the `site` values in `config.ts` (e.g. "bbc.com", "reuters.com"). */
const directFeedUrls: Record<string, string> = {
  "bbc.com": "https://feeds.bbci.co.uk/news/rss.xml",
  "reuters.com": "https://www.reuters.com/rss/?service=rss",
  "cnn.com": "https://rss.cnn.com/rss/edition.rss",
  "npr.org": "https://npr.org/rss/rss.xml",
  "aljazeera.com": "https://www.aljazeera.com/xml/rss/all.xml",
  "theguardian.com": "https://www.theguardian.com/uk/rss",
  "apnews.com": "https://apnews.com/hub/rss/ap-top-news",
  "thehill.com": "https://thehill.com/feed/?feed=partnerfeed-news-feed&format=rss",
  "france24.com": "https://www.france24.com/en/rss",
  "dw.com": "https://rss.dw.com/rdf/rss-en-world",
  "news.sky.com": "https://feeds.skynews.com/feeds/rss/world.xml",
  "cnbc.com": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "theverge.com": "https://www.theverge.com/rss/index.xml",
  "abcnews.go.com": "https://abcnews.com/abcnews/topstories",
  "nbcnews.com": "https://feeds.nbcnews.com/nbcnews/public/news",
  "usatoday.com": "https://rssfeeds.usatoday.com/usatoday-NewsTopStories",
  "independent.co.uk": "https://www.independent.co.uk/rss",
  "politico.com": "https://www.politico.com/rss",
};

/**
 * Outlet-name variants that Google News appends to titles ("Headline - BBC")
 * and ledes ("... text AP News"). The label itself is always included;
 * variants cover the common suffixes seen in the wild (verified against
 * live feeds: "AP News", "Al Jazeera English", "NPR News"…).
 */
function outletSuffixVariants(label: string): string[] {
  const variants = new Set<string>([label]);
  switch (label) {
    case "BBC":
      variants.add("BBC News");
      break;
    case "NPR":
      variants.add("NPR News");
      break;
    case "Al Jazeera":
      variants.add("Al Jazeera English");
      break;
    case "AP":
      variants.add("AP News");
      variants.add("Associated Press");
      break;
    case "The Guardian":
      variants.add("Guardian News & Media");
      variants.add("theguardian.com");
      break;
    case "The Hill":
      variants.add("thehill.com");
      break;
    case "Reuters":
      variants.add("Reuters.com");
      break;
    case "France 24":
      variants.add("France 24 English");
      break;
    case "DW":
      variants.add("Deutsche Welle");
      variants.add("DW News");
      break;
    case "Sky News":
      variants.add("Sky");
      break;
    case "ABC News":
      variants.add("ABC");
      break;
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/** Strip any known outlet suffix from the end of a lede or title. */
export function stripOutletSuffix(text: string, label: string): string {
  let out = text.trim();
  for (const variant of outletSuffixVariants(label)) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Variant at the end, optionally separated by a dash and/or surrounded
    // by ellipses ("… The Hill" / "The Hill…" / "… Reuters").
    const re = new RegExp(
      `\\s*[-–—·]?\\s*(?:[…\\s]+)?${escaped}(?:[…\\s]+)?\\s*$`,
      "i"
    );
    out = out.replace(re, "");
  }
  return out.trim();
}

/**
 * Fetch + validate a feed: explicit timeout, content-type sanity (an HTML
 * error page is NOT a feed), a body-size cap, and a per-feed item cap so a
 * misbehaving aggregator can't blow the Worker's memory or subrequest budget.
 */
async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AntiSpinRead/1.0; +https://github.com/anti-spin-read)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      cf: { cacheTtl: 300 },
      // Every redirect hop counts as a subrequest against the 50-per-
      // invocation budget, so don't follow chains: a 3xx counts as an empty
      // feed and the caller falls back to the Google News URL (1 hop).
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) return ""; // redirect → fallback
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/html")) {
      throw new Error(`feed returned HTML (${contentType}) — not an XML feed`);
    }
    const reader = res.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let out = "";
    while (out.length < MAX_FEED_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch latest articles from all configured outlets via direct RSS (with
 *  optional Google News fallback). Runs sources in bounded-size batches so
 *  that at most `SCRAPE_BATCH` feeds are fetched and parsed simultaneously —
 *  this keeps peak memory and parallel-subrequest count bounded. */
export async function scrapeAll(windowHours: number): Promise<RawArticle[]> {
  const articles: RawArticle[] = [];
  for (let i = 0; i < sources.length; i += SCRAPE_BATCH) {
    const batch = sources.slice(i, i + SCRAPE_BATCH);
    const results = await Promise.allSettled(
      batch.map((source) =>
        scrapeSource(source.label, source.site, windowHours)
      )
    );
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        articles.push(...r.value);
      } else {
        console.warn(`[scraper] ${batch[j].label} failed: ${r.reason}`);
      }
    });
  }
  console.log(`[scraper] collected ${articles.length} articles`);
  return articles;
}

async function scrapeSource(
  label: string,
  site: string,
  windowHours: number
): Promise<RawArticle[]> {
  // 1️⃣ Try direct RSS feed first (bypasses Google News IP block)
  const directUrl = directFeedUrls[site as keyof typeof directFeedUrls];
  let xml: string = "";
  if (directUrl) {
    console.log(`[scraper] fetching direct RSS for ${label} from ${directUrl}`);
    xml = await fetchFeedXml(directUrl);
  }

  // 2️⃣ If direct feed returned empty, fall back to Google News
  if (!xml || xml.length === 0) {
    console.log(`[scraper] direct feed empty for ${label}, falling back to Google News`);
    const googleUrl = googleNewsFeedUrl(site, windowHours);
    xml = await fetchFeedXml(googleUrl);
  }

  if (!xml) return [];
  const feed = await parser.parseString(xml);

  const articles: RawArticle[] = [];
  const items = feed.items.slice(0, MAX_ITEMS_PER_FEED);
  for (const item of items) {
    if (!item.title) continue;
    const title = item.title.trim();
    if (!title) continue;

    const normalized = normalizeTitle(title);
    if (!normalized) continue;

    const publishedAt = item.isoDate ? new Date(item.isoDate) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;

    // Google News titles have format "Headline - Site Name"; strip it and
    // any lingering outlet suffix (site-name variants vary by outlet).
    const cleanTitle = stripOutletSuffix(
      title.replace(/\s+-\s+[^-]*$/, ""),
      label
    );
    // Prefer the raw content:encoded field: rss-parser's contentSnippet
    // strips tags AFTER xml2js decodes entities, so escaped angle brackets
    // in the text ("&lt;no&gt;") are destroyed. Raw content keeps them
    // encoded, and stripHtml below handles tags + entities in the right
    // order. Google News sends short snippets in both fields.
    // Google News sends short snippets in both fields. Raw content also
    // carries the thumbnail <img> — extracted for the imageUrl (SSRF-gated).
    const rawContent = item.content ?? item.contentSnippet ?? "";
    const rawLede = stripHtml(rawContent);
    const lede = stripOutletSuffix(rawLede, label);
    const rawUrl = item.link ?? "";
    // Google News RSS items carry redirect URLs (news.google.com/rss/articles/…)
    // that don't resolve to the article's og:image. Resolve them to the actual
    // article URL before storing so enrichment can fetch the right page.
    const resolvedUrl = rawUrl.includes("news.google.com/rss/articles/")
      ? await resolveGoogleNewsUrl(rawUrl)
      : rawUrl;
    articles.push({
      dedupKey: `${label}|${hashText(normalized)}`,
      source: label,
      title: cleanTitle,
      url: resolvedUrl,
      lede,
      publishedAt,
      // Feed-carried image when the feed provides one (Google News
      // thumbnails, media:content, enclosure); otherwise the pipeline's
      // enrichment fetches the og:image post-clustering.
      imageUrl: extractFeedImage(item),
    });
  }
  return articles;
}