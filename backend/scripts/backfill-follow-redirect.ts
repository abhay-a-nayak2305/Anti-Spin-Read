/**
 * One-off backfill for the last image-less cluster-referenced articles:
 * Google-News redirect links (NPR, USA Today) and pages that block the
 * Worker. Runs LOCALLY with unlimited subrequests, so it follows redirect
 * chains (the Worker's fetchOgImage deliberately can't), extracts og:image
 * from the final page and writes image_url through the D1 REST API.
 *
 *   npx tsx scripts/backfill-follow-redirect.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { extractOgImage, isSafeHttpUrl } from "../src/images.js";

const ACCOUNT = "e8e83ce5a550c16e907abfb865da09e6";
const DB_ID = "4d1d3b1e-e5cc-451c-980a-0d87087fe85c";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
  const rows = await d1Query(
    token,
    `SELECT DISTINCT a.dedup_key AS k, a.url AS u
     FROM articles a
     JOIN cluster_articles ca ON ca.dedup_key = a.dedup_key
     WHERE a.image_url = ''`
  );
  console.log(`[backfill] ${rows.length} cluster-referenced articles missing an image`);

  let enriched = 0;
  for (const r of rows) {
    if (!isSafeHttpUrl(r.u)) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(r.u, {
        redirect: "follow", // local run — no subrequest budget
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      clearTimeout(timer);
      if (!res.ok || !isSafeHttpUrl(res.url)) {
        console.log(`[backfill]   ${r.u.substring(0, 60)}… -> HTTP ${res.status}, no image`);
        continue;
      }
      const html = await res.text();
      const og = extractOgImage(html);
      if (!og) {
        console.log(`[backfill]   ${r.u.substring(0, 60)}… -> no og:image on page`);
        continue;
      }
      await d1Query(
        token,
        `UPDATE articles SET image_url = '${esc(og)}' WHERE dedup_key = '${esc(r.k)}'`
      );
      enriched++;
      console.log(`[backfill]   ${r.u.substring(0, 60)}… -> ${og.substring(0, 70)}`);
    } catch (e) {
      console.log(`[backfill]   ${r.u.substring(0, 60)}… -> error ${(e as Error).message}`);
    }
  }
  console.log(`[backfill] done: ${enriched}/${rows.length} enriched`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});