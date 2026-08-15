import { categorizeCluster, CATEGORY_IDS } from "../src/categorize.js";
import type { ClusterRecord, IFraming } from "../src/types.js";

// Deterministic unit tests for the categoriser — no network, no LLM.

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

const now = Date.now();

function cluster(
  keyPhrase: string,
  opts: {
    titles?: string[];
    ledes?: string[];
    summary?: string;
  } = {}
): ClusterRecord {
  const titles = opts.titles ?? [keyPhrase, keyPhrase];
  const ledes = opts.ledes ?? ["", ""];
  const articles = titles.map((title, i) => ({
    dedupKey: `t|${title}`,
    source: i % 2 ? "BBC" : "CNN",
    title,
    url: `https://example.com/${i}`,
    lede: ledes[i] ?? "",
    publishedAt: new Date(now - 3600_000),
    imageUrl: "",
  }));
  const framing: IFraming | null = opts.summary
    ? {
        headlineDeltas: [],
        toneTags: [],
        notableOmissions: [],
        neutralSummary: opts.summary,
      }
    : null;
  return {
    id: "1",
    keyPhrase,
    seenAt: new Date(now),
    framedAt: new Date(now),
    framingError: null,
    framing,
    articles,
  };
}

console.log("== test: headline-driven categories ==");
{
  check(
    "election/president headline -> politics",
    categorizeCluster(cluster("Trump wins the presidential election")) === "politics"
  );
  check(
    "war headline -> world",
    categorizeCluster(cluster("Russia launches missile strikes in Ukraine war")) === "world"
  );
  check(
    "earnings headline -> business",
    categorizeCluster(cluster("Nvidia shares surge after record earnings report")) === "business"
  );
  check(
    "AI/chip headline -> tech",
    categorizeCluster(cluster("OpenAI unveils new AI chip to rival Nvidia")) === "tech"
  );
  check(
    "vaccine headline -> science-health",
    categorizeCluster(cluster("New vaccine trial shows promise against disease")) === "science-health"
  );
  check(
    "verdict headline -> crime-justice",
    categorizeCluster(cluster("Jury returns guilty verdict in fraud trial")) === "crime-justice"
  );
  check(
    "super bowl headline -> culture-sport",
    categorizeCluster(cluster("Championship match ends in dramatic win at the super bowl")) === "culture-sport"
  );
}

console.log("== test: neutral summary + lede contribute ==");
{
  check(
    "summary mentions inflation -> business",
    categorizeCluster(
      cluster("Markets watch the data closely", {
        summary: "The central bank cut interest rates as inflation cooled and the economy stabilized.",
      })
    ) === "business"
  );
  check(
    "lede mentions arrest -> crime-justice",
    categorizeCluster(
      cluster("Suspect appears in court", {
        titles: ["Suspect appears in court", "Suspect appears in court"],
        ledes: ["Police arrested the suspect after a long investigation.", "The trial begins next week."],
      })
    ) === "crime-justice"
  );
}

console.log("== test: fallback and priority ==");
{
  check(
    "no keywords -> other",
    categorizeCluster(cluster("Local community gathers for annual picnic")) === "other"
  );
  check(
    "trump + stock tie -> politics wins (priority order)",
    categorizeCluster(cluster("Trump company stock soars after election")) === "politics"
  );
}

console.log("== test: category list complete ==");
{
  check(
    "all 8 categories exported",
    CATEGORY_IDS.length === 8,
    `got ${CATEGORY_IDS.length}`
  );
}

console.log("\n=====================");
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);