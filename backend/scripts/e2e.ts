import { runPipeline } from "../src/pipeline.js";
import { MemoryDb } from "../src/db-memory.js";
import type { Env } from "../src/types.js";

// End-to-end pipeline test with an in-memory Db.
// Scraping + clustering run against live Google News RSS; the Gemini
// framing step will record framingError when no key is configured.

const env = { GEMINI_API_KEY: "", CRON_SECRET: "e2e-secret", DB: {} } as Env;
const db = new MemoryDb();

async function main() {
  console.log("== run 1: fresh pipeline ==");
  const r1 = await runPipeline(env, db);
  console.log("run1:", JSON.stringify(r1));

  const articles = db.articles.size;
  const clusters = db.clusters.length;
  const framed = db.clusters.filter((c) => c.framing !== null).length;
  console.log(`stored: articles=${articles} clusters=${clusters} framed=${framed}`);

  if (articles === 0) throw new Error("FAIL: no articles stored");
  if (framed > 0) throw new Error("FAIL: framing without a key should not succeed");
  if (clusters === 0) console.log("NOTE: 0 cross-outlet clusters this cycle (depends on live news)");

  console.log("== run 2: repeat run (idempotency) ==");
  const r2 = await runPipeline(env, db);
  console.log("run2:", JSON.stringify(r2));
  if (db.articles.size !== articles) {
    throw new Error(`FAIL: idempotency broken (${articles} -> ${db.articles.size})`);
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
