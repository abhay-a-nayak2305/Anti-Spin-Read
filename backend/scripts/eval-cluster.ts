import { clusterArticles } from "../src/cluster.js";
import type { RawArticle } from "../src/types.js";

/**
 * Clustering evaluator: replays a labeled corpus (English + Arabic + CJK,
 * duplicates, near-dups, shared-boilerplate decoys, junk) through the real
 * clusterArticles pipeline and scores precision/recall against the labels.
 *
 * Gate: precision >= 0.8 AND recall >= 0.7, else exit 1. Run in CI after
 * any change to cluster.ts.
 */

interface Labeled {
  article: RawArticle;
  /** Expected cluster group id; null = must NOT cluster with anything. */
  group: string | null;
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function art(source: string, title: string, hoursAgo: number, group: string | null): Labeled {
  return {
    group,
    article: {
      dedupKey: `${source}|${title}`,
      source,
      title,
      url: `https://${source}.example/${encodeURIComponent(title)}`,
      lede: "",
      publishedAt: new Date(Date.now() - hoursAgo * 3600_000),
      imageUrl: "",
    },
  };
}

const corpus: Labeled[] = [
  // --- English: story A, 3 outlets ---
  art("BBC", "Ousted Syrian dictator Bashar al-Assad sentenced to death in absentia", 3, "A"),
  art("CNN", "Former Syrian President Assad sentenced to death in absentia", 2, "A"),
  art("NPR", "Syrian court sentences Bashar al-Assad to death in absentia", 1, "A"),
  // --- English: story B, 2 outlets ---
  art("Reuters", "Trump media company announces a massive loss", 5, "B"),
  art("Guardian", "Trump's media company reports $238m loss", 4, "B"),
  // --- English: story C, 2 outlets ---
  art("AP", "Jackie, the California bald eagle who became an internet sensation, dies after illness", 3, "C"),
  art("BBC", "Jackie, the famous California bald eagle, dies after weeks of intensive care", 2, "C"),
  // --- Decoy: shared boilerplate, different subjects (must NOT cluster) ---
  art("Reuters", "Dollar steady as traders await key US inflation data", 2, null),
  art("Reuters", "Gold gains as markets await key US inflation data", 1, null),
  // --- Decoy: same topic, different stories ---
  art("CNN", "Trump signs order to limit childhood vaccines and split MMR shots", 2, null),
  art("NPR", "Trump announces new White House counsel Will Scharf", 1, null),
  // --- Same-source near-duplicate (must coalesce, not pair) ---
  art("CNN", "WAPO: Trump secretly switched planes using catering truck", 4, null),
  art("CNN", "How Trump Secretly Switched Planes Using Catering Truck", 3, null),
  // --- Junk titles (must be dropped) ---
  art("BBC", "Today | 10/08/2026", 1, null),
  // --- Arabic: same story, 2 outlets (non-English support) ---
  art("Al Jazeera", "محكمة سورية تصدر حكما غيابيا بإعدام بشار الأسد", 2, "AR"),
  art("BBC", "محكمة في دمشق تصدر حكما بإعدام بشار الأسد غيابيا", 1, "AR"),
  // --- Chinese: same story, 2 outlets (CJK support) ---
  art("CCTV", "中国宣布推出新经济刺激方案以提振增长", 2, "ZH"),
  art("Reuters", "中国发布新经济刺激措施 推动经济增长", 1, "ZH"),
];

function main(): void {
  const clusters = clusterArticles(corpus.map((l) => l.article));

  // Build expected pairs from labels
  const groups = new Map<string, string[]>();
  for (const l of corpus) {
    if (l.group === null) continue;
    const list = groups.get(l.group) ?? [];
    list.push(l.article.dedupKey);
    groups.set(l.group, list);
  }
  const expected = new Set<string>();
  let expectedCount = 0;
  for (const keys of groups.values()) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const [x, y] = [keys[i], keys[j]].sort();
        expected.add(`${x}||${y}`);
        expectedCount++;
      }
    }
  }

  // Actual pairs from output clusters
  const actual = new Set<string>();
  let actualCount = 0;
  let correct = 0;
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const [x, y] = [cluster[i].dedupKey, cluster[j].dedupKey].sort();
        const pair = `${x}||${y}`;
        actual.add(pair);
        actualCount++;
        if (expected.has(pair)) correct++;
      }
    }
  }
  const precision = actualCount === 0 ? 1 : correct / actualCount;
  const recall = expectedCount === 0 ? 1 : correct / expectedCount;

  // Human-readable cluster report
  console.log(`\nclusters produced: ${clusters.length}`);
  for (const [i, c] of clusters.entries()) {
    console.log(
      `  #${i + 1} (${c.length}): ` +
        c.map((a) => `${a.source} — ${a.title.slice(0, 40)}`).join(" | ")
    );
  }

  console.log(`\nexpected pairs: ${expectedCount}, actual pairs: ${actualCount}, correct: ${correct}`);
  console.log(`precision: ${(precision * 100).toFixed(1)}%  recall: ${(recall * 100).toFixed(1)}%`);

  check("precision >= 80%", precision >= 0.8, `precision ${precision}`);
  check("recall >= 70%", recall >= 0.7, `recall ${recall}`);
  check("no cluster mixes different stories (decoy check)",
    [...actual].every((p) => expected.has(p)), `unexpected pairs: ${[...actual].filter((p) => !expected.has(p)).join(", ")}`);

  console.log(`\n=====================\nRESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();