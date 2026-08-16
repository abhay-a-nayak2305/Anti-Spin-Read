/**
 * One-off backfill: images for cluster-referenced articles that og:image
 * enrichment can never get (publishers blocking the Worker, or Google-News
 * redirect links whose pages are unreachable) — but whose RSS feeds embed
 * images (Google News <img> thumbnails, media:content/enclosure). Matches
 * feed items to stored rows by exact URL and writes image_url through the
 * D1 REST API.
 *
 *   npx tsx scripts/backfill-feed-images.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Parser from "rss-parser";
import { extractFeedImage } from "../src/scraper.js";

const ACCOUNT = "e8e83ce5a550c16e907abfb865da09e6";
const DB_ID = "4d1d3b1e-e5cc-451c-980a-0d87087fe85c";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Sources whose stored articles still lack images + the feed to match. */
const FEEDS: Record<string, string> = {
  "The Hill": "https://thehill.com/feed/?feed=partnerfeed-news-feed&format=rss",
  "Sky News": "https://feeds.skynews.com/feeds/rss/world.xml",
  DW: "https://rss.dw.com/rdf/rss-en-world",
  NPR: "https://news.google.com/rss/search?q=when:48h%20site:npr.org&hl=en-US&gl=US&ceid=US:en",
  "USA Today":
    "https://news.google.com/rss/search?q=when:48h%20site:usatoday.com&hl=en-US&gl=US&ceid=US:en",
  "The Independent": "https://www.independent.co.uk/rss",
};

function oauthToken(): string {
  const paths = [
    join(homedir(), "AppData", "Roaming", "xdg.config", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ];
  for (const p of paths) {
    try {
      const cfg = readFileSync(p, "utf8");
      const m = /oauth_token = "([^"]+)"/.exec(cfg);
      if (m) return m[1];
    } catch {
      /* try next */
    }
  }
  throw new Error("no wrangler OAuth token found — run `npx wrangler whoami` first");
}

function esc(v: string): string {
  return v.replaceAll("'", "''");
}

async function d1Query(
  token: string,
  sql: string
): Promise<{ results: Record<string, string>[] } | null> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    }
  );
  const data = (await res.json()) as { success: boolean; result?: { results: Record<string, string>[] }[] };
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data)}`);
  return data.result?.[0] ?? null;
}

async function main(): Promise<void> {
  const token = oauthToken();
  const parser = new Parser({ timeout: 15000 });

  // 1. All cluster-referenced articles still missing an image.
  const missing = await d1Query(
    token,
    `SELECT DISTINCT a.dedup_key AS k, a.url AS u, a.source AS s
     FROM articles a
     JOIN cluster_articles ca ON ca.dedup_key = a.dedup_key
     WHERE a.image_url = ''`
  );
  const rows = missing?.results ?? [];
  console.log(`[backfill] ${rows.length} cluster-referenced articles missing an image`);

  const bySource = new Map<string, { k: string; u: string }[]>();
  for (const r of rows) {
    const list = bySource.get(r.s) ?? [];
    list.push({ k: r.k, u: r.u });
    bySource.set(r.s, list);
  }

  // 2. Fetch each source's feed once and index items by URL.
  const urlToImage = new Map<string, string>();
  const sourceToImages = new Map<string, Map<string, string>>();
  for (const [source, feedUrl] of Object.entries(FEEDS)) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
        redirect: "manual",
      });
      if (res.status >= 300 || !res.ok) {
        console.log(`[backfill] ${source}: feed ${res.status} — skipped`);
        continue;
      }
      const xml = await res.text();
      const feed = await parser.parseString(xml);
      const index = new Map<string, string>();
      for (const item of feed.items) {
        const img = extractFeedImage(item as unknown as Record<string, unknown>);
        if (img && item.link) index.set(item.link, img);
      }
      sourceToImages.set(source, index);
      urlToImage.set(source, feedUrl);
      console.log(`[backfill] ${source}: ${feed.items.length} items, ${index.size} with images`);
    } catch (e) {
      console.log(`[backfill] ${source}: error ${(e as Error).message} — skipped`);
    }
  }

  // 3. Match stored rows to feed items and write image_url.
  let set = 0;
  for (const [source, list] of bySource) {
    const index = sourceToImages.get(source);
    if (!index) {
      console.log(`[backfill] ${source}: no feed index, ${list.length} rows left`);
      continue;
    }
    for (const r of list) {
      const img = index.get(r.u);
      if (!img) continue;
      await d1Query(
        token,
        `UPDATE articles SET image_url = '${esc(img)}' WHERE dedup_key = '${esc(r.k)}'`
      );
      set++;
      console.log(`[backfill]   ${source}: ${r.u.substring(0, 70)}…`);
    }
  }
  console.log(`[backfill] done: ${set}/${rows.length} enriched via feed images`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});