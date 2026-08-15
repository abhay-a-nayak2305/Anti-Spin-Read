import type { RawArticle } from "./types.js";

const STOPWORDS = new Set(
  `a an and are as at be but by for from has have he her his i if in into is it its
   of on or that the their them they this to was were will with would what when where
   who whom whose why how which while after before between during over under again
   further then once here there all any both each few more most other some such no
   nor not only own same so than too very s t can just don should now says said
   report reports reporting new latest update updates live`
    .split(/\s+/)
);

/** Template headlines: same text, different subject = different story.
 *  e.g. "AP Decision Notes: What to expect in X's state primary" */
const TITLE_BLOCKLIST = [/^ap decision notes/i, /^today \|/i];

const THRESHOLD = 0.45;
const NEAR_DUP_JACCARD = 0.7;
const RARE_MAX = 5;
const RARE_BOOST = 2;
/** An article only compares against the most recent CLUSTER_WINDOW clusters.
 *  Temporal-locality tradeoff: a late-arriving 2nd outlet for an old story
 *  won't join it, but it keeps single-pass clustering fast and local. */
const CLUSTER_WINDOW = 8;

export interface ClusterOptions {
  threshold?: number;
  nearDupJaccard?: number;
  rareMax?: number;
  rareBoost?: number;
  clusterWindow?: number;
}

// CJK headlines are single unsegmented tokens — split them into overlapping
// character bigrams so differently-worded headlines still share signal.
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text
    .toLowerCase()
    // Unicode-aware: keeps Arabic/Cyrillic/Greek letters and CJK ideographs
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)) {
    if (!raw) continue;
    if (CJK_RE.test(raw)) {
      // Expand CJK runs to overlapping bigrams; keep any Latin/digit parts
      // as plain tokens (e.g. "GDP增长" -> ["gd", "p增"...] handled below).
      let last = 0;
      for (const m of raw.matchAll(CJK_RUN_RE)) {
        const idx = m.index ?? 0;
        if (idx > last) {
          const latin = raw.slice(last, idx).replace(/[^\p{L}\p{N}]/gu, "");
          if (latin) tokens.push(latin);
        }
        const run = m[0];
        for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
        last = idx + run.length;
      }
      if (last < raw.length) {
        const latin = raw.slice(last).replace(/[^\p{L}\p{N}]/gu, "");
        if (latin) tokens.push(latin);
      }
    } else {
      tokens.push(raw);
    }
  }
  return tokens.filter(
    (t) =>
      t.length >= 2 &&
      !STOPWORDS.has(t) &&
      !/^\d+$/u.test(t) // drop pure numbers: "2 arrested" vs "2 killed"
  );
}

/** Very short/generic titles are live-blog pings or junk ("Today | 10/08/2026")
 *  — not comparable stories. CJK titles produce many bigrams, so they clear
 *  the length bar on their own. */
function isJunk(tokens: string[], raw: string): boolean {
  if (tokens.length >= 3) return false;
  if (tokens.length === 0) return true;
  const joined = tokens.join("");
  if (joined.length >= 8 && CJK_RE.test(raw)) return false;
  return true;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

export interface ClusteredArticle extends RawArticle {
  tokens: string[];
  tokenSet: Set<string>;
}

/**
 * Greedy single-pass clustering.
 *
 * A match requires shared *rare* tokens (distinctive words — proper nouns,
 * facts — appearing in very few corpus articles), so shared boilerplate
 * ("markets await key inflation data") never glues unrelated stories.
 * Final clusters must span 2+ DIFFERENT outlets — the product is comparing
 * how outlets differ, not catching same-outlet duplicates.
 */
export function clusterArticles(
  articles: RawArticle[],
  opts: ClusterOptions = {}
): ClusteredArticle[][] {
  const threshold = opts.threshold ?? THRESHOLD;
  const nearDupJaccard = opts.nearDupJaccard ?? NEAR_DUP_JACCARD;
  const rareMax = opts.rareMax ?? RARE_MAX;
  const rareBoost = opts.rareBoost ?? RARE_BOOST;
  const clusterWindow = opts.clusterWindow ?? CLUSTER_WINDOW;

  // 1. Coalesce same-source duplicates (live blogs, repeated items).
  //    Track ALL seen titles per source (not just exact matches) so
  //    near-identical titles (variant wording) are caught too.
  const seenBySource = new Map<string, string[]>();
  const tokenCache = new Map<string, Set<string>>();
  const deduped: RawArticle[] = [];
  for (const a of articles) {
    if (TITLE_BLOCKLIST.some((re) => re.test(a.title))) continue;
    const key = a.title.toLowerCase().replace(/\s+/g, " ").trim();
    const seenTitles = seenBySource.get(a.source) ?? [];
    let duplicate = false;
    for (const prev of seenTitles) {
      if (prev === key) {
        duplicate = true;
        break;
      }
      let prevSet = tokenCache.get(prev);
      if (!prevSet) {
        prevSet = new Set(tokenize(prev));
        tokenCache.set(prev, prevSet);
      }
      let curSet = tokenCache.get(key);
      if (!curSet) {
        curSet = new Set(tokenize(key));
        tokenCache.set(key, curSet);
      }
      if (prevSet.size > 0 && jaccard(prevSet, curSet) >= nearDupJaccard) {
        duplicate = true; // near-identical same-source duplicate
        break;
      }
    }
    if (duplicate) continue;
    seenTitles.push(key);
    seenBySource.set(a.source, seenTitles);
    deduped.push(a);
  }

  // 2. Tokenize once; drop junk; sort by time so the "latest clusters first"
  //    window (temporal locality) actually sees same-moment stories —
  //    feeds arrive grouped by source, which would otherwise hide clusters.
  const parsed: ClusteredArticle[] = [];
  for (const a of deduped) {
    const tokens = tokenize(a.title);
    if (isJunk(tokens, a.title)) continue;
    parsed.push({ ...a, tokens, tokenSet: new Set(tokens) });
  }
  parsed.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  // 3. Corpus rarity: "rare" = appears in <= rareMax articles.
  //    Outlet boilerplate ("await key inflation data") appears 10+ times;
  //    story specifics (absentia, catering, gilman) 1-5x — but big stories
  //    get covered everywhere, so rarity is a BOOST, not a gate.
  const freq = new Map<string, number>();
  for (const p of parsed) {
    for (const t of p.tokenSet) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  /**
   * Composite similarity: Jaccard boosted by the share of shared tokens
   * that are corpus-rare.
   *   - Shared boilerplate only       -> rareFrac 0   -> plain Jaccard
   *   - Shared distinctive vocabulary -> rareFrac 0.4+ -> strong boost
   */
  const score = (x: Set<string>, y: Set<string>): number => {
    let shared = 0;
    let rareShared = 0;
    for (const t of x) {
      if (y.has(t)) {
        shared++;
        if ((freq.get(t) ?? 99) <= rareMax) rareShared++;
      }
    }
    if (shared === 0) return 0;
    const union = x.size + y.size - shared;
    const j = shared / union;
    const rareFrac = rareShared / shared;
    return j * (1 + rareBoost * rareFrac);
  };

  // 4. Single-pass greedy clustering (latest clusters first — temporal locality)
  const clusters: ClusteredArticle[][] = [];
  for (const article of parsed) {
    let placed = false;
    const start = Math.max(0, clusters.length - clusterWindow);
    for (let i = clusters.length - 1; i >= start; i--) {
      const cluster = clusters[i];
      const rep = cluster[0];
      if (score(article.tokenSet, rep.tokenSet) < threshold) continue;

      cluster.push(article);
      placed = true;
      break;
    }
    if (!placed) clusters.push([article]);
  }

  // 5. Keep only clusters spanning 2+ different outlets
  return clusters.filter((c) => {
    const outlets = new Set(c.map((a) => a.source));
    return outlets.size >= 2;
  });
}