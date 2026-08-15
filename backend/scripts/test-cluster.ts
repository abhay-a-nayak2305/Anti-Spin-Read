import { clusterArticles } from "../src/cluster.js";
import type { RawArticle } from "../src/types.js";

// Deterministic unit tests for the clustering engine.
// Synthetic headlines with known expected behavior — no network.

let passed = 0;
let failed = 0;

function art(source: string, title: string, hoursAgo = 1): RawArticle {
  return {
    dedupKey: `${source}|${title}`,
    source,
    title,
    url: `https://${source}.example/${title.replace(/\s+/g, "-")}`,
    lede: "",
    publishedAt: new Date(Date.now() - hoursAgo * 3600_000),
    imageUrl: "",
  };
}

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== test: clusters require 2+ different outlets ==");
{
  const clusters = clusterArticles([
    art("BBC", "Assad sentenced to death in absentia"),
    art("BBC", "Assad sentenced to death in absentia"),
  ]);
  check(
    "two BBC-only articles form no cluster",
    clusters.length === 0,
    `got ${clusters.length}`
  );
}

console.log("== test: same story across outlets clusters ==");
{
  const clusters = clusterArticles([
    art("BBC", "Ousted Syrian dictator Bashar al-Assad sentenced to death in absentia", 3),
    art("CNN", "Former Syrian President Assad sentenced to death in absentia", 2),
    art("NPR", "Syrian court sentences Bashar al-Assad to death in absentia", 1),
  ]);
  check(
    "three outlets same story -> one cluster of 3",
    clusters.length === 1 && clusters[0].length === 3,
    JSON.stringify(clusters.map((c) => c.length))
  );
}

console.log("== test: related-but-different stories do NOT cluster ==");
{
  const clusters = clusterArticles([
    art("Reuters", "Dollar steady as traders await key US inflation data"),
    art("Reuters", "Gold gains as markets await key US inflation data"),
  ]);
  check(
    "dollar vs gold — shared boilerplate only -> no cluster",
    clusters.length === 0,
    `got ${clusters.length}`
  );
}

// Same templates, different subject — must NOT cluster
{
  const clusters = clusterArticles([
    art("AP", "AP Decision Notes: What to expect in Connecticut's state primary"),
    art("AP", "AP Decision Notes: What to expect in Wisconsin's state primary"),
  ]);
  check(
    "template headlines with different subjects -> no cluster (blocklisted)",
    clusters.length === 0,
    `got ${clusters.length}`
  );
}

console.log("== test: junk / live-blog titles dropped ==");
{
  const clusters = clusterArticles([
    art("BBC", "Today | 10/08/2026"),
    art("BBC", "Iran war live"),
    art("Al Jazeera", "Iran war live"),
  ]);
  check(
    "junk titles (too short / blocklisted) never form clusters",
    clusters.length === 0,
    `got ${clusters.length}`
  );
}

console.log("== test: same-source near-duplicates coalesced ==");
{
  const clusters = clusterArticles([
    art("CNN", "WAPO: Trump secretly switched planes using catering truck"),
    art("CNN", "How Trump Secretly Switched Planes Using Catering Truck"),
    art("BBC", "Trump hid in catering truck in secret plane swap over Iran threat, reports say"),
  ]);
  check(
    "two CNN near-dupes + BBC -> single cluster of 2 (CNN deduped)",
    clusters.length === 1 && clusters[0].length === 2,
    JSON.stringify(clusters.map((c) => c.map((a) => a.source)))
  );
}

console.log("== test: distinct stories same topic stay separate ==");
{
  // Both about Trump, different stories (vaccines vs Iran deal)
  const clusters = clusterArticles([
    art("CNN", "Trump signs order to limit childhood vaccines and split MMR shots"),
    art("NPR", "Trump announces new White House counsel Will Scharf"),
  ]);
  check(
    "two unrelated Trump stories -> no cluster",
    clusters.length === 0,
    `got ${clusters.length}`
  );
}

console.log("== test: word-order variation still clusters ==");
{
  const clusters = clusterArticles([
    art("BBC", "Jackie, the famous California bald eagle, dies after weeks of intensive care"),
    art("AP", "Jackie, the California bald eagle who became an internet sensation, dies after illness"),
  ]);
  check(
    "heavily reworded same story -> one cluster of 2",
    clusters.length === 1 && clusters[0].length === 2,
    JSON.stringify(clusters.map((c) => c.length))
  );
}

console.log("== test: temporal window works when items interleave ==");
{
  // Feed order is per-source grouped; clustering sorts by time internally.
  const clusters = clusterArticles([
    art("BBC", "Russia releases former US Marine reported in poor health", 5),
    art("Reuters", "Syria sentences absent Bashar al-Assad to death over killings", 4),
    art("CNN", "Former US Marine Robert Gilman released from detention in Russia", 3),
    art("AP", "Trump media company announces a massive loss", 2),
    art("Guardian", "Trump's media company reports $238m loss", 1),
  ]);
  check(
    "interleaved sources cluster within window -> clusters: Marine + Trump media",
    clusters.length === 2,
    JSON.stringify(
      clusters.map((c) => c.map((a) => `${a.source}:${a.title.slice(0, 20)}`))
    )
  );
}

console.log("\n=====================");
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);