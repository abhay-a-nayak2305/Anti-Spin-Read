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

const TONE_COLORS: Record<string, string> = {
  neutral: "bg-paper text-ink",
  urgent: "bg-acid text-ink",
  alarmist: "bg-alarm text-paper",
  skeptical: "bg-paper text-ink border-dashed",
  celebratory: "bg-acid text-ink",
  analytical: "bg-paper text-ink",
};

export function toneClass(tone: string): string {
  return TONE_COLORS[tone] ?? TONE_COLORS.neutral;
}

export type FramingStatus = "FRAMED" | "FAILED" | "PENDING";

/** Derive the framing status stamp from a cluster's framing fields. */
export function framingStatus(cluster: Cluster): FramingStatus {
  if (cluster.framing) return "FRAMED";
  if (cluster.framingError) return "FAILED";
  return "PENDING";
}

/** Per-category brutalist styling — each category owns a color. */
export interface CategoryMeta {
  label: string;
  /** stamp chip: colored background badge */
  stamp: string;
  /** colored offset shadow for cards / modal */
  shadow: string;
  /** accent text color */
  text: string;
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
    text: "text-cat-politics",
  },
  world: {
    label: "World",
    stamp: "bg-cat-world text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-world)]",
    text: "text-cat-world",
  },
  business: {
    label: "Business",
    stamp: "bg-cat-business text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-business)]",
    text: "text-cat-business",
  },
  tech: {
    label: "Tech",
    stamp: "bg-cat-tech text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-tech)]",
    text: "text-cat-tech",
  },
  "science-health": {
    label: "Science & Health",
    stamp: "bg-cat-science text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-science)]",
    text: "text-cat-science",
  },
  "crime-justice": {
    label: "Crime & Justice",
    stamp: "bg-cat-crime text-paper border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-crime)]",
    text: "text-cat-crime",
  },
  "culture-sport": {
    label: "Culture & Sport",
    stamp: "bg-cat-culture text-ink border-ink",
    shadow: "shadow-[8px_8px_0_var(--color-cat-culture)]",
    text: "text-cat-culture",
  },
  other: {
    label: "Other",
    stamp: "bg-paper text-ink border-ink border-dashed",
    shadow: "shadow-[8px_8px_0_var(--color-ink)]",
    text: "text-paper",
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