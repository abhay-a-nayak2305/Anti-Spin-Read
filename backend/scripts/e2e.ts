import { runPipeline } from "../src/pipeline.js";
import { MemoryDb } from "../src/db-memory.js";
import type { Env, PipelineResult } from "../src/types.js";

// End-to-end pipeline test with an in-memory Db, run against live Google
// News RSS. The Gemini framing step will record framingError when no key
// is configured.
//
// Live data varies in two ways this harness is deliberately tolerant of:
//  - Google News can transiently block or drop requests, yielding 0
//    articles on a given attempt; the scrape is retried a few times before
//    a failure is declared (a *persistent* empty scrape is still a failure —
//    it would signal a real scraper regression).
//  - Headlines shift between the two runs, so a handful of genuinely-new
//    articles may legitimately appear on the second run; a small drift is
//    accepted, while a drop in articles or drift beyond tolerance still
//    fails (that would signal a real dedup regression).

const SCRAPE_ATTEMPTS = 3;
const SCRAPE_RETRY_DELAY_MS = 5_000;
const HEADLINE_DRIFT_TOLERANCE = 5;

const env = { GEMINI_API_KEY: "", CRON_SECRET: "e2e-secret", DB: {} } as Env;

/** Run the pipeline until a run actually stores articles (retrying the
 *  transient empty-scrape case), then return that db + result. */
async function runUntilArticles(): Promise<{ db: MemoryDb; result: PipelineResult }> {
  let result: PipelineResult | null = null;
  for (let attempt = 1; attempt <= SCRAPE_ATTEMPTS; attempt++) {
    const db = new MemoryDb();
    result = await runPipeline(env, db);
    if (db.articles.size > 0) return { db, result };
    if (attempt < SCRAPE_ATTEMPTS) {
      console.log(
        `scrape retry ${attempt}/${SCRAPE_ATTEMPTS}: 0 articles stored (transient?), retrying in ${SCRAPE_RETRY_DELAY_MS}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, SCRAPE_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    `FAIL: no articles stored after ${SCRAPE_ATTEMPTS} scrape attempts — Google News likely unreachable from this runner`
  );
}

async function main() {
  console.log("== run 1: fresh pipeline ==");
  const { db, result: r1 } = await runUntilArticles();
  console.log("run1:", JSON.stringify(r1));

  const articles = db.articles.size;
  const clusters = db.clusters.length;
  const framed = db.clusters.filter((c) => c.framing !== null).length;
  console.log(`stored: articles=${articles} clusters=${clusters} framed=${framed}`);

  if (framed > 0) throw new Error("FAIL: framing without a key should not succeed");
  if (clusters === 0) console.log("NOTE: 0 cross-outlet clusters this cycle (depends on live news)");

  console.log("== run 2: repeat run (idempotency) ==");
  const r2 = await runPipeline(env, db);
  console.log("run2:", JSON.stringify(r2));

  const drift = db.articles.size - articles;
  if (drift < 0) {
    throw new Error(`FAIL: idempotency broken — articles decreased (${articles} -> ${db.articles.size})`);
  }
  if (drift > HEADLINE_DRIFT_TOLERANCE) {
    throw new Error(
      `FAIL: idempotency broken — ${drift} new articles appeared between runs (tolerance ${HEADLINE_DRIFT_TOLERANCE})`
    );
  }
  if (drift > 0) {
    console.log(`note: ${drift} new article(s) between runs (live headline drift, within tolerance)`);
  }
  console.log("idempotency OK");

  // Sample a cluster record
  const sample = db.clusters[0];
  if (sample) {
    console.log("sample cluster:", {
      keyPhrase: sample.keyPhrase.slice(0, 80),
      articles: sample.articleKeys.length,
      framingError: sample.framingError?.slice(0, 80),
    });
  }

  console.log("== PASS ==");
  process.exit(0);
}

main().catch((err) => {
  console.error("== FAIL ==", err);
  process.exit(1);
});
