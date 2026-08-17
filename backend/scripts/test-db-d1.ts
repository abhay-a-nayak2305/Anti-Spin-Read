import { D1Db } from "../src/db.js";
import { SqliteD1 } from "./sqlite-d1.js";
import type { RawArticle } from "../src/types.js";

// Data-layer integration tests against a REAL SQLite engine with the REAL
// migrations applied (see scripts/sqlite-d1.ts). The old string-matching
// stub emulated behavior instead of executing SQL, which is how the
// ambiguous-column JOIN bug shipped. These tests fail loudly on any SQL
// syntax/ambiguity/constraint error.

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

function art(
  source: string,
  title: string,
  publishedAt = new Date("2026-08-14T12:00:00Z")
): RawArticle {
  return {
    dedupKey: `${source}|${title}`,
    source,
    title,
    url: `https://${source.toLowerCase()}.example/${title.replace(/\s+/g, "-")}`,
    lede: `${title} lede`,
    publishedAt,
    imageUrl: "",
  };
}

function framingJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    headlineDeltas: ["Delta"],
    toneTags: [{ source: "BBC", tone: "neutral" }],
    notableOmissions: [],
    neutralSummary: "A neutral summary.",
    ...overrides,
  });
}

/** Apply the production migrations to a fresh DB and return a D1Db. */
function makeDb() {
  const d1 = new SqliteD1();
  return { db: new D1Db(d1 as any), d1 };
}

async function seedCluster(
  db: D1Db,
  articles: RawArticle[],
  seenAt: Date,
  sig: string
): Promise<number> {
  await db.insertArticles(articles);
  return db.createCluster("Cluster", articles.map((a) => a.dedupKey), seenAt, sig);
}

console.log("== test: migrations apply cleanly ==");
{
  const { db } = makeDb();
  // The schema the code depends on exists, exactly as deployed. If any
  // migration were broken (bad SQL, missing table), these fail loudly.
  check(
    "articles table usable",
    (await db.insertArticles([art("BBC", "First")])).length === 1
  );
}

console.log("== test: insertArticles with real SQL ==");
{
  const { db, d1 } = makeDb();
  const a = art("BBC", "Unique story");
  check("single insert returned", (await db.insertArticles([a])).length === 1);
  check("duplicate insert ignored", (await db.insertArticles([a])).length === 0);

  const many = Array.from({ length: 130 }, (_, i) =>
    art("CNN", `Story number ${i}`)
  );
  d1.batchSizes.length = 0; // only count the bulk-insert batches
  const inserted = await db.insertArticles(many);
  check("130 inserts all returned", inserted.length === 130);
  check("chunked into 2 batches (100 + 30)", d1.batchSizes.join(",") === "100,30");

  const recent = await db.recentArticles(new Date("2026-08-01T00:00:00Z"));
  check("recentArticles returns all 131", recent.length === 131);
}

console.log("== test: createCluster sig idempotency ==");
{
  const { db } = makeDb();
  const arts = [art("BBC", "Same"), art("CNN", "Same")];
  const id1 = await seedCluster(db, arts, new Date(), "sig-1");
  const id2 = await seedCluster(db, arts, new Date(), "sig-1");
  check("same sig returns same id", id1 === id2);
  const id3 = await seedCluster(
    db,
    [art("BBC", "Different"), art("CNN", "Different")],
    new Date(),
    "sig-2"
  );
  check("different sig creates new cluster", id3 !== id1);
}

console.log("== test: clusterExistsWithFraming ==");
{
  const { db } = makeDb();
  const arts = [art("BBC", "Framed story"), art("CNN", "Framed story")];
  const id = await seedCluster(db, arts, new Date(), "sig-f");
  check("no framing yet -> false", !(await db.clusterExistsWithFraming(arts.map((a) => a.dedupKey))));
  await db.saveFraming(id, JSON.parse(framingJson()), new Date(), null);
  check("framed -> true", await db.clusterExistsWithFraming(arts.map((a) => a.dedupKey)));
  await db.saveFraming(id, null, null, "boom");
  check("failed framing -> not framed", !(await db.clusterExistsWithFraming(arts.map((a) => a.dedupKey))));
}

console.log("== test: latestClusters two-query completeness (C1) ==");
{
  const { db } = makeDb();
  const base = new Date("2026-08-14T00:00:00Z");
  for (let i = 0; i < 55; i++) {
    const arts = [
      art("BBC", `Cluster story ${i}`, new Date(base.getTime() + i * 60_000)),
      art("CNN", `Cluster story ${i}`, new Date(base.getTime() + i * 60_000)),
    ];
    await seedCluster(db, arts, new Date(base.getTime() + i * 60_000), `sig-${i}`);
  }
  const clusters = await db.latestClusters(50);
  check("exactly 50 clusters returned (no JOIN truncation)", clusters.length === 50);
  const allHaveBoth = clusters.every((c) => c.articles.length === 2);
  check("every cluster keeps ALL its articles", allHaveBoth);
  const times = clusters.map((c) => c.seenAt.getTime());
  check("newest first", times.every((t, i) => i === 0 || t <= times[i - 1]));
}

console.log("== test: latestClusters IN-chunking at 90 ==");
{
  const { db, d1 } = makeDb();
  const base = new Date("2026-08-14T00:00:00Z");
  for (let i = 0; i < 95; i++) {
    await seedCluster(
      db,
      [art("BBC", `Story ${i}`, base), art("CNN", `Story ${i}`, base)],
      new Date(base.getTime() + i),
      `sig-${i}`
    );
  }
  d1.batchSizes.length = 0; // reset: count only the article-fetch chunks
  d1.executed.length = 0;
  await db.latestClusters(95);
  const inStatements = d1.executed.filter((s) => s.includes("WHERE ca.cluster_id IN"));
  check("article fetch chunked into 90 + 5", inStatements.length === 2);
  const first = inStatements[0].match(/\?/g)?.length ?? 0;
  const second = inStatements[1].match(/\?/g)?.length ?? 0;
  check("first chunk has 90 placeholders", first === 90);
  check("second chunk has 5 placeholders", second === 5);
}

console.log("== test: framing validation at rest ==");
{
  const { db } = makeDb();
  const arts = [art("BBC", "Valid"), art("CNN", "Valid")];
  const id = await seedCluster(db, arts, new Date(), "sig-v");
  // Corrupt JSON
  await (db as any).env.prepare(
    "UPDATE clusters SET framing = ? WHERE id = ?"
  ).bind("{not json", id).run();
  check("corrupt JSON row skipped", (await db.latestClusters(10)).length === 0);
  // Structurally invalid JSON (missing neutralSummary) must be skipped too
  await (db as any).env.prepare(
    "UPDATE clusters SET framing = ? WHERE id = ?"
  ).bind(framingJson({ neutralSummary: "" }), id).run();
  check("structurally invalid framing skipped", (await db.latestClusters(10)).length === 0);
  // Valid framing round-trips
  await (db as any).env.prepare(
    "UPDATE clusters SET framing = ? WHERE id = ?"
  ).bind(framingJson(), id).run();
  const clusters = await db.latestClusters(10);
  check("valid framing parsed", clusters.length === 1 && clusters[0].framing?.neutralSummary === "A neutral summary.");
}

console.log("== test: searchClusters + clusterById (real SQL) ==");
{
  const { db } = makeDb();
  const t0 = new Date("2026-08-14T10:00:00Z");
  const t1 = new Date("2026-08-14T11:00:00Z");
  const idA = await seedCluster(
    db,
    [art("BBC", "Bashar al-Assad sentenced"), art("CNN", "Assad sentenced")],
    t0,
    "sig-search-a"
  );
  const idB = await seedCluster(
    db,
    [art("Guardian", "Trump media company reports loss"), art("Reuters", "Trump Media loss")],
    t1,
    "sig-search-b"
  );
  await db.saveFraming(idA, JSON.parse(framingJson()), new Date(), null);

  const byAssad = await db.searchClusters("assad", 10);
  check("keyPhrase match found", byAssad.some((c) => c.id === String(idA)));
  check("title match found", byAssad.some((c) => c.id === String(idB)) === false);

  const byTrump = await db.searchClusters("trump", 10);
  check("article-title match found", byTrump.some((c) => c.id === String(idB)));

  const ledeHit = await db.searchClusters("sentenced lede", 10);
  check("lede match found", ledeHit.some((c) => c.id === String(idA)));

  check("newest first", byAssad.length >= 1 && byAssad[0].id === String(idA));
  const cap = await db.searchClusters("assad", 1);
  check("limit honored", cap.length === 1);

  const wild = await db.searchClusters("%", 10);
  check("LIKE metachar escaped (no match-all)", wild.length === 0);
  const underscore = await db.searchClusters("_", 10);
  check("underscore escaped (no match-all)", underscore.length === 0);

  const one = await db.clusterById(String(idB));
  check("clusterById found", one !== null && one.id === String(idB));
  check("clusterById attaches articles", one?.articles.length === 2);
  check("clusterById attaches framing", (await db.clusterById(String(idA)))?.framing !== null);
  check("clusterById missing -> null", (await db.clusterById("999999")) === null);
}

console.log("== test: sitemapMeta ==");
{
  const { db } = makeDb();
  await seedCluster(db, [art("BBC", "S1")], new Date("2026-08-15T00:00:00Z"), "s-1");
  await seedCluster(db, [art("CNN", "S2")], new Date("2026-08-16T00:00:00Z"), "s-2");
  await seedCluster(db, [art("AP", "S3")], new Date("2026-08-17T00:00:00Z"), "s-3");
  const meta = await db.sitemapMeta(10);
  check("newest first", meta[0].id === "3" && meta[2].id === "1");
  check("seenAt carried", meta[2].seenAt.toISOString() === "2026-08-15T00:00:00.000Z");
  const limited = await db.sitemapMeta(2);
  check("limit honored", limited.length === 2);
}

console.log("== test: clustersNeedingFraming retry queue ==");
{
  const { db } = makeDb();
  const base = new Date("2026-08-14T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    await seedCluster(
      db,
      [art("BBC", `Queued ${i}`, base), art("CNN", `Queued ${i}`, base)],
      new Date(base.getTime() + i),
      `sig-q-${i}`
    );
  }
  const q = await db.clustersNeedingFraming(50);
  check("returns 50 of 60", q.length === 50);
  const order = q.map((r) => r.id);
  check("oldest first", order.every((id, i) => i === 0 || id >= order[i - 1]));
  check("articles attached", q.every((r) => r.articles.length === 2));
}

console.log("== test: pipeline lock (real CHECK constraint + lease) ==");
{
  const { db } = makeDb();
  const now = Date.now();
  check("first run acquires", await db.acquirePipelineLock("a"));
  check("second concurrent run blocked", !(await db.acquirePipelineLock("b")));
  check("same token still owner", await db.acquirePipelineLock("a"));
  await db.releasePipelineLock("a");
  check("released -> others acquire", await db.acquirePipelineLock("b"));
  await db.releasePipelineLock("b");
  // Wrong token cannot release someone else's lock
  await db.acquirePipelineLock("c");
  await db.releasePipelineLock("nope");
  check("wrong token cannot release", !(await db.acquirePipelineLock("d")));
  // Expired lease stolen (backdate the row directly; 16 min > 15-min lease)
  await (db as any).env.prepare(
    "UPDATE pipeline_lock SET acquired_at = ? WHERE id = 1"
  ).bind(now - 16 * 60_000).run();
  check("expired lease stolen", await db.acquirePipelineLock("e"));
}

console.log("== test: purgeOldData retention ==");
{
  const { db } = makeDb();
  const cutoff = Date.now() - 14 * 24 * 3600_000;
  const old = new Date(cutoff - 3600_000);
  const fresh = new Date(cutoff + 3600_000);

  // Old cluster (will be purged; cascade removes its cluster_articles)
  const oldArts = [art("BBC", "Old story", old), art("CNN", "Old story", old)];
  await seedCluster(db, oldArts, old, "sig-old");
  // Fresh cluster (stays)
  const freshArts = [art("BBC", "Fresh story", fresh), art("CNN", "Fresh story", fresh)];
  await seedCluster(db, freshArts, fresh, "sig-fresh");
  // Old orphan article with NO cluster (purged)
  await db.insertArticles([art("NPR", "Old orphan", old)]);
  // Recent orphan article with NO cluster (kept — may cluster later)
  await db.insertArticles([art("NPR", "Recent orphan", fresh)]);

  const purged = await db.purgeOldData(cutoff, cutoff);
  check("old cluster purged", purged.clusters === 1);
  // The cluster DELETE ran first, so its two articles became unreferenced
  // within the same call and were purged alongside the old orphan: 3 total.
  check("old orphan + cascade-orphaned articles purged", purged.articles === 3);
  check("no run-log rows in this block", purged.runs === 0);

  const clusters = await db.latestClusters(10);
  check("fresh cluster survives", clusters.length === 1 && clusters[0].keyPhrase === "Cluster");
  const recent = await db.recentArticles(new Date(cutoff - 1000));
  const keys = recent.map((a) => a.title);
  check("recent orphan kept", keys.includes("Recent orphan"));
  check("old orphan gone", !keys.includes("Old orphan"));
  const purged2 = await db.purgeOldData(cutoff, cutoff);
  check("second purge removes nothing", purged2.clusters === 0 && purged2.articles === 0 && purged2.runs === 0);
}

console.log("== test: pipeline run log retention (90d) ==");
{
  const { db } = makeDb();
  const runsCutoff = Date.now() - 90 * 24 * 3600_000;
  const oldRun = new Date(runsCutoff - 3600_000);
  const recentRun = new Date(runsCutoff + 3600_000);

  const mkRun = (startedAt: Date) => ({
    startedAt,
    finishedAt: startedAt,
    scraped: 120,
    newArticles: 30,
    clusters: 4,
    framed: 3,
    failed: 1,
    skipped: 0,
    error: null,
  });
  await db.recordPipelineRun(mkRun(oldRun));
  await db.recordPipelineRun(mkRun(recentRun));

  const purged = await db.purgeOldData(runsCutoff, runsCutoff);
  check("old run-log row purged", purged.runs === 1);

  const runs = await db.latestPipelineRuns(10);
  check("recent run kept", runs.length === 1 && runs[0].startedAt.getTime() === recentRun.getTime());
  check("old run gone", !runs.some((r) => r.startedAt.getTime() === oldRun.getTime()));

  const purged2 = await db.purgeOldData(runsCutoff, runsCutoff);
  check("second purge removes no run rows", purged2.runs === 0);
}

console.log("== test: recentUnclusteredArticles clustering pool ==");
{
  const { db } = makeDb();
  const now = Date.now();
  const fresh = new Date(now - 60_000);
  const old = new Date(now - 3 * 3600_000);
  await db.insertArticles([
    art("BBC", "Fresh unclustered", fresh),
    art("CNN", "Old unclustered", old),
  ]);
  // A clustered article must never appear in the pool.
  const clustered = [art("BBC", "Already clustered", fresh), art("CNN", "Already clustered", fresh)];
  await seedCluster(db, clustered, fresh, "sig-pool");

  const pool = await db.recentUnclusteredArticles(new Date(now - 2 * 3600_000), 100);
  const titles = pool.map((a) => a.title);
  check("fresh unclustered article in pool", titles.includes("Fresh unclustered"));
  check("old unclustered article excluded by cutoff", !titles.includes("Old unclustered"));
  check("clustered article excluded", !titles.includes("Already clustered"));
  check("pool newest first", pool.length > 0 && pool[0].title === "Fresh unclustered");

  const capped = await db.recentUnclusteredArticles(new Date(now - 48 * 3600_000), 1);
  check("limit honored", capped.length === 1 && capped[0].title === "Fresh unclustered");
}

console.log("== test: articlesInClustersMissingImages catch-up queue ==");
{
  const { db, d1 } = makeDb();
  const now = new Date();
  await db.insertArticles([
    art("BBC", "No image clustered", new Date(now.getTime() - 60_000)),
    art("CNN", "Has image clustered", new Date(now.getTime() - 120_000)),
    art("BBC", "No image unclustered", new Date(now.getTime() - 180_000)),
  ]);
  const clustered = [art("BBC", "No image clustered", now), art("CNN", "Has image clustered", now)];
  await seedCluster(db, clustered, now, "sig-img");
  await db.setArticleImage("CNN|Has image clustered", "https://img.example/x.jpg");

  const queue = await db.articlesInClustersMissingImages(10, Date.now() + 86_400_000);
  const titles = queue.map((a) => a.title);
  check("clustered article without image queued", titles.includes("No image clustered"));
  check("clustered article WITH image not queued", !titles.includes("Has image clustered"));
  check("unclustered article not queued", !titles.includes("No image unclustered"));

  const capped = await db.articlesInClustersMissingImages(1, Date.now() + 86_400_000);
  check("limit honored", capped.length === 1);

  // Retry gate: a recent failed attempt takes the article out of the queue.
  await db.markEnrichAttempt("BBC|No image clustered", Date.now());
  const gated = await db.articlesInClustersMissingImages(10, Date.now() - 60_000);
  check("recently-attempted article gated out", !gated.some((a) => a.title === "No image clustered"));
  const ungated = await db.articlesInClustersMissingImages(10, Date.now() + 86_400_000);
  check("old-enough attempt back in the queue", ungated.some((a) => a.title === "No image clustered"));
  // Migration 0006 column exists and the update landed.
  const attemptRow = await d1
    .prepare("SELECT last_enrich_attempt_ms FROM articles WHERE dedup_key = 'BBC|No image clustered'")
    .first();
  check(
    "last_enrich_attempt_ms column persisted",
    Number(attemptRow?.last_enrich_attempt_ms) > 0
  );
}

console.log("== test: meta upsert ==");
{
  const { db } = makeDb();
  check("missing key -> null", (await db.getMeta("nope")) === null);
  await db.setMeta("last_purge_ms", "1000");
  await db.setMeta("last_purge_ms", "2000");
  check("upsert keeps one row with latest value", (await db.getMeta("last_purge_ms")) === "2000");
}

console.log("== test: pipeline run event log ==");
{
  const { db } = makeDb();
  check("empty log -> empty list", (await db.latestPipelineRuns(10)).length === 0);
  const t1 = new Date(Date.now() - 60_000);
  const t2 = new Date();
  await db.recordPipelineRun({
    startedAt: t1,
    finishedAt: t1,
    scraped: 120,
    newArticles: 30,
    clusters: 4,
    framed: 3,
    failed: 1,
    skipped: 0,
    error: null,
  });
  await db.recordPipelineRun({
    startedAt: t2,
    finishedAt: t2,
    scraped: 90,
    newArticles: 10,
    clusters: 2,
    framed: 2,
    failed: 0,
    skipped: 0,
    error: "Gemini HTTP 500: boom",
  });
  const runs = await db.latestPipelineRuns(10);
  check("two runs recorded", runs.length === 2);
  check("newest first", runs[0].startedAt.getTime() === t2.getTime());
  check("counts persisted", runs[0].scraped === 90 && runs[0].framed === 2 && runs[0].failed === 0);
  check("error persisted", runs[0].error?.includes("Gemini HTTP 500") === true);
  check("clean run has null error", runs[1].error === null);
  const one = await db.latestPipelineRuns(1);
  check("limit respected", one.length === 1 && one[0].id === runs[0].id);
}

console.log(`\n=====================\nRESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);