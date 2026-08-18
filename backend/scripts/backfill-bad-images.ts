/**
 * One-off backfill: clear image_url for articles whose stored og:image is
 * from a CDN that blocks hotlinking from the Workers origin (Guardian
 * i.guim.co.uk returns 401 "missing signature"), or whose URL contains
 * HTML-encoded ampersands (&amp;) that corrupt query parameters.
 *
 * The regular pipeline enrichment will refill what it can on the next run;
 * Guardian articles will remain empty (monogram) — that CDN requires a
 * signed URL.
 *
 *   npx tsx scripts/backfill-bad-images.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

async function d1Query(token: string, sql: string): Promise<Record<string, string>[]> {
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
  return data.result?.[0]?.results ?? [];
}

async function main(): Promise<void> {
  const token = oauthToken();

  // Articles whose image_url is known to be broken:
  // 1. Guardian CDN (i.guim.co.uk) — returns 401 "missing signature" from Workers origin
  // 2. HTML-encoded ampersands (&amp;) in query strings — corrupts URL parameters
  const badRows = await d1Query(
    token,
    `SELECT dedup_key, image_url
     FROM articles
     WHERE image_url != ''
       AND (
         image_url LIKE '%i.guim.co.uk%'
         OR image_url LIKE '%&amp;%'
       )`
  );

  if (badRows.length === 0) {
    console.log("[backfill] no bad image URLs found — nothing to do");
    return;
  }

  console.log(`[backfill] clearing ${badRows.length} bad image URLs`);
  for (const r of badRows.slice(0, 5)) {
    console.log(`  - ${r.dedup_key}: ${r.image_url.slice(0, 80)}...`);
  }
  if (badRows.length > 5) console.log(`  ... and ${badRows.length - 5} more`);

  // Clear image_url + last_enrich_attempt_ms so the regular pipeline
  // catch-up will retry (and the retry gate won't block them).
  const keys = badRows.map((r) => `'${esc(r.dedup_key)}'`).join(",");
  await d1Query(
    token,
    `UPDATE articles
     SET image_url = '', last_enrich_attempt_ms = 0
     WHERE dedup_key IN (${keys})`
  );

  console.log(`[backfill] done: ${badRows.length} rows cleared. They will be re-enriched over the next few pipeline runs.`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
