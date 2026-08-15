import type { ClusterRecord } from "./types.js";

/**
 * Deterministic story categorisation.
 *
 * Each category carries a weighted keyword list. A cluster is scored across
 * its keyPhrase, article titles, ledes and the neutral summary; the category
 * with the highest weighted hit count wins (ties broken by priority order).
 * Zero hits falls back to "other". No LLM call — free and instant.
 */

export type CategoryId =
  | "politics"
  | "world"
  | "business"
  | "tech"
  | "science-health"
  | "crime-justice"
  | "culture-sport"
  | "other";

interface CategoryRule {
  id: Exclude<CategoryId, "other">;
  /** Words scored 2 — unmistakable story anchors */
  strong: string[];
  /** Words scored 1 — broad topic signals */
  weak: string[];
}

const RULES: CategoryRule[] = [
  {
    id: "politics",
    strong: [
      "election", "elections", "president", "senate", "congress", "white house",
      "supreme court", "cabinet", "legislation", "bill", "vote", "votes",
      "trump", "biden", "harris", "candidate", "campaign", "voters", "ballot",
      "impeach", "inauguration", "republican", "democrat", "primaries",
    ],
    weak: [
      "government", "policy", "political", "governor", "mayor", "parliament",
      "minister", "administration", "lawmakers", "senator", "debate", "polls",
      "tariff", "executive order", "speaker", "house of representatives",
    ],
  },
  {
    id: "world",
    strong: [
      "china", "russia", "ukraine", "iran", "israel", "gaza", "palestine",
      "nato", "eu", "putin", "xi jinping", "netanyahu", "kim jong",
      "war", "ceasefire", "missile", "invasion", "sanctions", "border",
    ],
    weak: [
      "summit", "diplomatic", "diplomacy", "ambassador", "united nations",
      "international", "g7", "g20", "conflict", "geopolitical", "troops",
      "military", "president of", "prime minister of", "foreign",
    ],
  },
  {
    id: "business",
    strong: [
      "stock", "stocks", "market", "markets", "inflation", "recession",
      "earnings", "quarterly", "ipo", "merger", "bankruptcy", "layoffs",
      "ceo", "profit", "revenue", "company", "companies", "shareholders",
      "dow jones", "s&p 500", "nasdaq", "interest rates", "fed",
    ],
    weak: [
      "economy", "economic", "business", "trade", "bank", "banks", "currency",
      "tax", "taxes", "gdp", "unemployment", "jobs report", "investors",
      "fund", "startup", "retail", "sales", "wallet", "prices", "investor",
    ],
  },
  {
    id: "tech",
    strong: [
      "openai", "google", "apple", "microsoft", "meta", "amazon", "nvidia",
      "chatgpt", "ai", "artificial intelligence", "semiconductor", "chip",
      "cyberattack", "hack", "hackers", "data breach", "tesla", "spacex",
    ],
    weak: [
      "tech", "technology", "software", "hardware", "algorithm", "robot",
      "robotaxi", "app", "smartphone", "iphone", "android", "quantum",
      "tiktok", "twitter", "instagram", "facebook", "silicon valley",
      "gadget", "device", "cloud", "cyber",
    ],
  },
  {
    id: "science-health",
    strong: [
      "vaccine", "vaccines", "covid", "outbreak", "pandemic", "nasa",
      "mars", "space station", "clinical trial", "drug", "fda", "virus",
      "disease", "cancer", "alzheimer",
    ],
    weak: [
      "health", "medical", "doctor", "doctors", "hospital", "patients",
      "research", "study", "scientists", "science", "climate", "emissions",
      "wildfire", "hurricane", "earthquake", "launch", "orbit", "asteroid",
      "gene", "brain", "antibiotics",
    ],
  },
  {
    id: "crime-justice",
    strong: [
      "arrest", "arrested", "guilty", "verdict", "trial", "court", "indict",
      "indicted", "convicted", "sentence", "sentenced", "prosecutor",
      "murder", "killed", "shooting", "prison", "jail", "charged",
    ],
    weak: [
      "crime", "criminal", "police", "investigation", "investigators",
      "lawsuit", "sued", "lawsuit filed", "justice", "judge", "jury",
      "evidence", "suspect", "felony", "appeal", "fbi", "justice department",
    ],
  },
  {
    id: "culture-sport",
    strong: [
      "super bowl", "nba", "nfl", "nhl", "mlb", "olympics", "world cup",
      "championship", "champion", "soccer", "cricket", "tennis", "grand slam",
      "oscars", "grammy", "movie", "film", "album", "concert", "celebrity",
    ],
    weak: [
      "sport", "sports", "team", "coach", "player", "players", "match",
      "league", "goal", "medal", "tournament", "actor", "actress",
      "entertainment", "music", "artist", "festival", "tv show", "series",
      "book", "museum", "theater",
    ],
  },
];

const STRONG = 2;
const WEAK = 1;

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;
}

/** Score a category against the normalized corpus text. */
function scoreCategory(rule: CategoryRule, corpus: string): number {
  let score = 0;
  for (const w of rule.strong) {
    if (corpus.includes(` ${w} `)) score += STRONG;
  }
  for (const w of rule.weak) {
    if (corpus.includes(` ${w} `)) score += WEAK;
  }
  return score;
}

/** Build the searchable corpus for one cluster. */
function clusterCorpus(cluster: ClusterRecord): string {
  const parts: string[] = [cluster.keyPhrase];
  for (const a of cluster.articles) {
    parts.push(a.title, a.lede);
  }
  if (cluster.framing?.neutralSummary) {
    parts.push(cluster.framing.neutralSummary);
  }
  return normalize(parts.join(" "));
}

/**
 * Classify a cluster into one of the fixed categories.
 * Highest weighted score wins; ties resolve to the earlier rule (priority
 * order above — politics > world > business > tech > science > crime > culture).
 * Falls back to "other" when nothing matches.
 */
export function categorizeCluster(cluster: ClusterRecord): CategoryId {
  const corpus = clusterCorpus(cluster);
  let best: CategoryId = "other";
  let bestScore = 0;
  for (const rule of RULES) {
    const s = scoreCategory(rule, corpus);
    if (s > bestScore) {
      bestScore = s;
      best = rule.id;
    }
  }
  return best;
}

export const CATEGORY_IDS: CategoryId[] = [
  "politics",
  "world",
  "business",
  "tech",
  "science-health",
  "crime-justice",
  "culture-sport",
  "other",
];
