import type { Cluster } from "../types";
import { categoryMeta, timeAgo } from "../types";
import { HeroImage } from "./HeroImage";
import { SourceCountBadge } from "./badges";

/**
 * Compact grid card. Clicking the image or the headline opens the full
 * story details in the modal (dimmed backdrop, centered slab).
 */
export function StoryCard({
  cluster,
  onOpen,
  eager = false,
  isNew = false,
  saved = false,
  onToggleSave,
}: {
  cluster: Cluster;
  onOpen: (c: Cluster) => void;
  /** First card is above the fold — its hero may load eagerly. */
  eager?: boolean;
  /** Story appeared since the user's last acknowledged visit. */
  isNew?: boolean;
  /** Story is in the reader's saved bookmarks. */
  saved?: boolean;
  /** Wired by App — omitted in tests and standalone usage → no Save button. */
  onToggleSave?: (c: Cluster) => void;
}) {
  const sourceCount = cluster.articles.length;
  const hero = cluster.articles[0];
  const meta = categoryMeta(cluster.category);

  return (
    <article
      className={`story-card slab flex flex-col bg-paper ${meta.shadow} ${meta.border}`}
      style={{ "--cat": meta.selection } as React.CSSProperties}
    >
      {/* clickable image — the hero always renders: og:image when present,
          otherwise the letter-monogram placeholder, so every story card
          shows an image even when enrichment found nothing (no stretched
          favicon — a site logo full-bleed reads as a wrong image) */}
      <button
        type="button"
        onClick={() => onOpen(cluster)}
        aria-label={`Open details: ${cluster.keyPhrase}`}
        className="block w-full border-b-2 border-ink text-left group"
      >
        <div className="relative">
          <HeroImage src={hero?.imageUrl ?? ""} site={hero?.url ?? ""} eager={eager} />
          <span className="absolute top-2 right-2 border-2 border-ink bg-ink px-1.5 py-0.5 font-display text-[10px] uppercase text-paper opacity-0 transition-opacity group-hover:opacity-100">
            Read →
          </span>
          {isNew && (
            <span className="absolute top-2 left-2 -rotate-2 border-2 border-ink bg-acid px-1.5 py-0.5 font-display text-[10px] uppercase text-ink shadow-[2px_2px_0_var(--color-ink)]">
              New
            </span>
          )}
        </div>
      </button>

      {/* clickable headline + meta */}
      <div className="flex flex-1 flex-col px-4 py-3">
        <button
          type="button"
          onClick={() => onOpen(cluster)}
          aria-label={`Open details: ${cluster.keyPhrase}`}
          className="text-left group"
        >
          <h3 className="font-display text-base leading-snug group-hover:underline group-hover:underline-offset-2">
            {cluster.keyPhrase}
          </h3>
        </button>

        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t-2 border-ink/10 pt-3">
          <span className={`stamp ${meta.stamp} text-[10px]`}>
            {meta.label}
          </span>
          {!cluster.framing && !cluster.framingError && (
            <span className="stamp stamp--pending text-[10px]">
              Framing…
            </span>
          )}
          <SourceCountBadge count={sourceCount} className="gap-1" />
          <span className="text-[10px] uppercase tracking-widest text-ink/50">
            {timeAgo(cluster.seenAt)}
          </span>
          {onToggleSave && (
            <button
              type="button"
              onClick={() => onToggleSave(cluster)}
              aria-label={saved ? "Unsave story" : "Save story"}
              aria-pressed={saved}
              title={saved ? "Unsave story" : "Save story"}
              className={`stamp text-[10px] transition-transform hover:-translate-y-0.5 ${
                saved ? meta.fill : `bg-paper ${meta.text}`
              }`}
            >
              {saved ? "♥ Saved" : "♥ Save"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}