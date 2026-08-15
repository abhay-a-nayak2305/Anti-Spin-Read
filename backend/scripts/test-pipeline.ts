import { runPipeline } from "../src/pipeline.js";
import { MemoryDb } from "../src/db-memory.js";
import type { Env, IFraming, RawArticle } from "../src/types.js";
import type { ClusteredArticle } from "../src/cluster.js";

// Pipeline integration tests with injected scrape/frame/enrich deps
// (never touches the network or Gemini).

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

const env: Env = {
  DB: undefined as never,
  ASSETS: undefined as never,
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-2.0-flash",
  CLUSTER_WINDOW_HOURS: "48",
};

function article(key: string, title: string, source = "s"): RawArticle {
  return {
    dedupKey: `${source}-${key}`,
    source,
    title,
    url: `https://example.com/${key}`,
    lede: `Lede for ${key}`,
    publishedAt: new Date(1_700_000_000_000),
    imageUrl: "",
  };
}

function framing(s: string): IFraming {
  return {
    headlineDeltas: [`delta for ${s}`],
    toneTags: [{ source: "s", tone: "analytical" }],
    notableOmissions: [],
    neutralSummary: s,
  };
}

console.log("== test: pipeline happy path ==");
{
  const db = new MemoryDb();
  const calls: { cluster: ClusteredArticle[]; opts: { apiKey?: string; model?: string; fallbackModel?: string } }[] = [];
  const result = await runPipeline(env, db, {
    scrape: async () => [
      article("a", "Breaking: widgets hit record high", "cnn"),
      article("b", "Widgets soar to record highs today", "bbc"),
      article("c", "Unrelated: cats", "ap"),
    ],
    frame: async (cluster, opts) => {
      calls.push({ cluster, opts });
      return framing("widgets boom");
    },
    enrich: async () => 0,
  });

  check("one cluster framed", result.framed === 1, JSON.stringify(result));
  check("scraped 3", result.scraped === 3);
  check("clusters found 1", result.clusters === 1);
  check("no failures", result.failed === 0);
  check("frame received apiKey + model", calls[0]?.opts.apiKey === "test-key" && calls[0]?.opts.model === "gemini-2.0-flash");
  check("frame received fallbackModel", calls[0]?.opts.fallbackModel === "gemini-1.5-flash");
  check("frame received both articles", calls[0]?.cluster.length === 2);
  check("lock released after run", db.lock === null);
  check("not skipped", result.skipped === undefined);
  const runs = await db.latestPipelineRuns(5);
  check(
    "run recorded in event log with counts",
    runs.length === 1 && runs[0].scraped === 3 && runs[0].clusters === 1 && runs[0].framed === 1,
    JSON.stringify(runs)
  );
  check("successful run has no error", runs[0]?.error === null);
}

console.log("== test: retry of failed framing (H1) ==");
{
  const db = new MemoryDb();
  let fail = true;
  const result1 = await runPipeline(env, db, {
    scrape: async () => [
      article("a", "Breaking: widgets hit record high", "cnn"),
      article("b", "Widgets soar to record highs today", "bbc"),
    ],
    frame: async () => {
      if (fail) throw new Error("Gemini HTTP 500");
      return framing("ok now");
    },
    enrich: async () => 0,
  });
  check("first run failed", result1.failed === 1 && result1.framed === 0);
  check("error recorded without leaking", db.clusters[0]?.framingError === "Gemini HTTP 500" && db.clusters[0]?.framing === null);

  fail = false;
  const result2 = await runPipeline(env, db, {
    scrape: async () => [
      article("a", "Breaking: widgets hit record high", "cnn"),
      article("b", "Widgets soar to record highs today", "bbc"),
    ],
    frame: async () => framing("retried"),
    enrich: async () => 0,
  });
  check("second run retried it", result2.framed === 1 && result2.failed === 0);
  check("framing persisted", db.clusters[0]?.framing?.neutralSummary === "retried");
  check("error cleared", db.clusters[0]?.framingError === null);
}

console.log("== test: sig dedup across runs (H5) ==");
{
  const db = new MemoryDb();
  const deps = {
    scrape: async () => [
      article("a", "Breaking: widgets hit record high", "cnn"),
      article("b", "Widgets soar to record highs today", "bbc"),
    ],
    frame: async () => framing("first"),
    enrich: async () => 0,
  };
  const r1 = await runPipeline(env, db, deps);
  const r2 = await runPipeline(env, db, deps);
  check("run 2 framed nothing new", r2.framed === 0 && r2.newArticles === 0);
  check("no duplicate clusters", db.clusters.length === 1, `${db.clusters.length}`);
  check("run 1 single framing", r1.framed === 1);
}

console.log("== test: overlapping runs blocked by lock ==");
{
  const db = new MemoryDb();
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((res) => (releaseGate = res));
  let started = false;

  const slow = runPipeline(env, db, {
    scrape: async () => {
      started = true;
      await gate; // hold the lock until we say so
      return [article("a", "Markets rally as inflation cools", "cnn"), article("b", "Inflation cools and markets rally", "bbc")];
    },
    frame: async () => framing("s"),
    enrich: async () => 0,
  });

  // Wait until the first run holds the lock
  while (!started) await new Promise((r) => setTimeout(r, 5));

  const second = await runPipeline(env, db, {
    scrape: async () => [article("a", "Markets rally as inflation cools", "cnn"), article("b", "Inflation cools and markets rally", "bbc")],
    frame: async () => framing("s"),
    enrich: async () => 0,
  });
  check("second run skipped (lock held)", second.skipped === true && second.framed === 0);
  const skippedRuns = await db.latestPipelineRuns(5);
  check(
    "skipped run recorded in event log",
    skippedRuns.some((r) => r.skipped === 1 && r.scraped === 0)
  );

  releaseGate();
  const first = await slow;
  check("first run completed after gate", first.framed === 1 && first.skipped === undefined);
  check("lock released", db.lock === null);
}

console.log("== test: single-article articles never framed ==");
{
  const db = new MemoryDb();
  const result = await runPipeline(env, db, {
    scrape: async () => [article("only", "Lonely story")],
    frame: async () => framing("nope"),
    enrich: async () => 0,
  });
  check("no clusters, no framings", result.clusters === 0 && result.framed === 0);
  check("no rows created", db.clusters.length === 0);
}

console.log("\n=====================");
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);