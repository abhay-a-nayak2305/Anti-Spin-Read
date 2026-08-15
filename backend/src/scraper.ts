import Parser from "rss-parser";
import { sources } from "./config.js";
import type { RawArticle } from "./types.js";

const parser = new Parser({ timeout: 15000 });

const FEED_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS_PER_FEED = 200;

/** Google News RSS filtered to one outlet's domain — stable, free, no per-site scraping */
function googleNewsFeedUrl(site: string, hours: number): string {
  const q = encodeURIComponent(`when:${hours}h site:${site}`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
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

function stripHtml(html: string): string {
  let out = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(replacement);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Direct RSS feed URLs for each outlet (official, public RSS endpoints).
 *  These bypass Google News entirely and work from any Cloudflare Worker IP. */
const directFeedUrls: Record<string, string> = {
  bbc: 'https://feeds.bbci.co.uk/news/rss.xml',
  reuters: 'https://www.reuters.com/rss/?service=rss',
  cnn: 'https://rss.cnn.com/rss/edition.rss',
  npr: 'https://npr.org/rss/rss.xml',
  aljazeera: 'https://www.aljazeera.com/rss',
  guardian: 'https://www.theguardian.com/rss',
  ap: 'https://apnews.com/hub/rss/ap-top-news',
  thehill: 'https://thehill.com/rss',
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
    });
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

/** Fetch latest articles from all configured outlets via Google News RSS */
export async function scrapeAll(windowHours: number): Promise<RawArticle[]> {
  const results = await Promise.allSettled(
    sources.map((source) => scrapeSource(source.label, source.site, windowHours))
  );

  const articles: RawArticle[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      articles.push(...r.value);
    } else {
      console.warn(`[scraper] ${sources[i].label} failed: ${r.reason}`);
    }
  });
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
    const rawLede = stripHtml(item.content ?? item.contentSnippet ?? "");
    const lede = stripOutletSuffix(rawLede, label);
    articles.push({
      dedupKey: `${label}|${hashText(normalized)}`,
      source: label,
      title: cleanTitle,
      url: item.link ?? "",
      lede,
      publishedAt,
      imageUrl: "", // enriched post-clustering by the pipeline
    });
  }
  return articles;
}