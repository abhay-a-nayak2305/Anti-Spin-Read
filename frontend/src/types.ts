export interface Article {
  source: string;
  title: string;
  url: string;
  lede: string;
  publishedAt: string;
  imageUrl: string;
}

export interface Framing {
  headlineDeltas: string[];
  toneTags: { source: string; tone: string }[];
  notableOmissions: string[];
  neutralSummary: string;
}

export type CategoryId =
  | "politics"
  | "world"
  | "business"
  | "tech"
  | "science-health"
  | "crime-justice"
  | "culture-sport"
  | "other";

export interface Cluster {
  id: string;
  keyPhrase: string;
  category: CategoryId;
  seenAt: string;
  framedAt: string | null;
  framingError: string | null;
  framing: Framing | null;
  articles: Article[];
}

export interface ClustersResponse {
  limit: number;
  offset: number;
  hasMore: boolean;
  clusters: Cluster[];
}

export interface SearchResponse {
  query: string;
  limit: number;
  hasMore: boolean;
  clusters: Cluster[];
}

/** Per-outlet spin aggregate from /api/tone-radar (last 200 framed stories). */
export interface ToneRadarOutlet {
  source: string;
  frames: number;
  spun: number;
  spinRatio: number;
  tones: Record<string, number>;
}

export interface ToneRadarResponse {
  computedAt: string;
  /** Echo of the requested category; null when no category filter was sent. */
  category?: string | null;
  outlets: ToneRadarOutlet[];
}

/** Per-outlet aggregates from /api/outlets/:name — zero-filled when the
 * outlet has no framed clusters. */
export interface OutletStat {
  source: string;
  frames: number;
  spun: number;
  spinRatio: number;
  tones: Record<string, number>;
}

export interface OutletResponse {
  outlet: string;
  hasMore: boolean;
  stat: OutletStat;
  clusters: Cluster[];
}

/** One entry of the pipeline run event log from /api/runs. */
export interface PipelineRun {
  id: number;
  startedAt: string;
  finishedAt: string;
  scraped: number;
  newArticles: number;
  clusters: number;
  framed: number;
  failed: number;
  /** 1 when the run was skipped because another run held the lock; 0 otherwise. */
  skipped: number;
  error: string | null;
}

export interface RunsResponse {
  runs: PipelineRun[];
  /** Unframed clusters still awaiting framing. */
  backlog: number;
}

const TONE_COLORS: Record<string, string> = {
  neutral: "bg-paper text-ink",
  urgent: "bg-cat-business text-ink",
  alarmist: "bg-alarm text-paper",
  skeptical: "bg-cat-culture text-paper border-dashed",
  celebratory: "bg-cat-science text-ink",
  analytical: "bg-cat-world text-ink",
};

export function toneClass(tone: string): string {
  return TONE_COLORS[tone] ?? TONE_COLORS.neutral;
}

/** Per-category brutalist styling — each category owns a color. */
export interface CategoryMeta {
  label: string;
  /** stamp chip: colored background badge */
  stamp: string;
  /** colored offset shadow for cards / modal */
  shadow: string;
  /** card/panel outline color (overrides the .slab ink border) */
  border: string;
  /** accent text color */
  text: string;
  /** solid fill (bg + readable text) for modal blocks — category-colored */
  fill: string;
  /** category color as a CSS var — used for text selection highlight */
  selection: string;
}

export const CATEGORY_ORDER: CategoryId[] = [
  "politics",
  "world",
  "business",
  "tech",
  "science-health",
  "crime-justice",
  "culture-sport",
  "other",
];

export const CATEGORY_META: Record<CategoryId, CategoryMeta> = {
  politics: {
    label: "Politics",
    stamp: "bg-cat-politics text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-politics)]",
    border: "border-ink",
    text: "text-cat-politics",
    fill: "bg-cat-politics text-ink",
    selection: "var(--color-cat-politics)",
  },
  world: {
    label: "World",
    stamp: "bg-cat-world text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-world)]",
    border: "border-ink",
    text: "text-cat-world",
    fill: "bg-cat-world text-ink",
    selection: "var(--color-cat-world)",
  },
  business: {
    label: "Business",
    stamp: "bg-cat-business text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-business)]",
    border: "border-ink",
    text: "text-cat-business",
    fill: "bg-cat-business text-ink",
    selection: "var(--color-cat-business)",
  },
  tech: {
    label: "Tech",
    stamp: "bg-cat-tech text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-tech)]",
    border: "border-ink",
    text: "text-cat-tech",
    fill: "bg-cat-tech text-ink",
    selection: "var(--color-cat-tech)",
  },
  "science-health": {
    label: "Science & Health",
    stamp: "bg-cat-science text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-science)]",
    border: "border-ink",
    text: "text-cat-science",
    fill: "bg-cat-science text-ink",
    selection: "var(--color-cat-science)",
  },
  "crime-justice": {
    label: "Crime & Justice",
    stamp: "bg-cat-crime text-paper border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-crime)]",
    border: "border-ink",
    text: "text-cat-crime",
    fill: "bg-cat-crime text-paper",
    selection: "var(--color-cat-crime)",
  },
  "culture-sport": {
    label: "Culture & Sport",
    stamp: "bg-cat-culture text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-culture)]",
    border: "border-ink",
    text: "text-cat-culture",
    fill: "bg-cat-culture text-ink",
    selection: "var(--color-cat-culture)",
  },
  other: {
    label: "Other",
    // White theme: solid white outline + white offset shadow (the old ink
    // outline and shadow were invisible against the black page) and a
    // white selection highlight. The stamp keeps its white fill.
    stamp: "bg-paper text-ink border-paper",
    shadow: "shadow-[8px_8px_0_var(--color-paper)]",
    border: "border-paper",
    text: "text-paper",
    fill: "bg-paper text-ink",
    selection: "var(--color-paper)",
  },
};

export function categoryMeta(category: string | undefined): CategoryMeta {
  return CATEGORY_META[(category as CategoryId) ?? "other"] ?? CATEGORY_META.other;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "pending";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Hostname of an article URL — scheme, path, query and fragment stripped. */
export function siteHostname(site: string): string {
  return site
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .replace(/\.$/, ""); // strip a single trailing dot (fully-qualified domain)
}

/**
 * Outlet favicon from the site's own origin — no third-party (Google)
 * tracking dependency. The browser only ever talks to the outlet itself.
 */
export function faviconUrl(site: string): string {
  const host = siteHostname(site);
  return host ? `https://${host}/favicon.ico` : "";
}

/**
 * First letter of the site hostname, uppercased — used for the zero-network
 * inline SVG letter badge when both og:image and the favicon fail.
 * A leading "www." is skipped so monograms stay distinctive.
 */
export function siteInitial(site: string): string {
  const letter = siteHostname(site).replace(/^www\./i, "").charAt(0);
  return letter ? letter.toUpperCase() : "?";
}