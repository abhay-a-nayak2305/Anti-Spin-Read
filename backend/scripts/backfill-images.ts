/**
 * One-off backfill: enrich og:image URLs for articles that are referenced
 * by a cluster but have no image yet (older clusters predate or missed
 * enrichment, so the UI shows image-less cards for them).
 *
 * Runs locally in Node (regex-extractor fallback in fetchOgImage; the
 * Workers HTMLRewriter path is not needed here), writes through the D1
 * REST API with the wrangler OAuth token. Safe to re-run (skips articles
 * that already have an image); failures are logged and left for the
 * pipeline's per-run enrichment catch-up.
 *
 *   npx tsx scripts/backfill-images.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "../src/db.js";
import { enrichArticleImages } from "../src/images.js";

const ACCOUNT = "e8e83ce5a550c16e907abfb865da09e6";
const DB_ID = "4d1d3b1e-e5cc-451c-980a-0d87087fe85c";

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

/** Minimal Db adapter: enrichArticleImages only calls setArticleImage. */
function makeRestDb(token: string): Db {
  return {
    async setArticleImage(dedupKey: string, imageUrl: string): Promise<void> {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            sql: `UPDATE articles SET image_url = '${esc(imageUrl)}' WHERE dedup_key = '${esc(dedupKey)}'`,
          }),
        }
      );
      const data = (await res.json()) as { success: boolean; errors?: unknown[] };
      if (!res.ok || !data.success) {
        throw new Error(`D1 update failed: ${JSON.stringify(data.errors ?? data)}`);
      }
    },
  } as unknown as Db;
}

async function main(): Promise<void> {
  const token = oauthToken();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: `SELECT DISTINCT a.dedup_key AS k, a.url AS u
              FROM articles a
              JOIN cluster_articles ca ON ca.dedup_key = a.dedup_key
              WHERE a.image_url = ''
              ORDER BY a.published_at DESC`,
      }),
    }
  );
  const data = (await res.json()) as {
    success: boolean;
    result?: { results: { k: string; u: string }[] }[];
  };
  if (!data.success) throw new Error(`query failed: ${JSON.stringify(data)}`);
  const rows = data.result?.[0]?.results ?? [];
  console.log(`[backfill] ${rows.length} cluster-referenced articles missing an image`);

  const articles = rows.map((r) => ({
    dedupKey: r.k,
    source: "backfill",
    title: "",
    url: r.u,
    lede: "",
    publishedAt: new Date(0),
    imageUrl: "",
  }));

  const enriched = await enrichArticleImages(makeRestDb(token), articles, rows.length);
  console.log(`[backfill] done: ${enriched}/${rows.length} enriched`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});