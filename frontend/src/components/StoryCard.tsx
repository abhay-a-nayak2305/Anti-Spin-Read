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
}: {
  cluster: Cluster;
  onOpen: (c: Cluster) => void;
  /** First card is above the fold — its hero may load eagerly. */
  eager?: boolean;
  /** Story appeared since the user's last acknowledged visit. */
  isNew?: boolean;
}) {
  const sourceCount = cluster.articles.length;
  const hero = cluster.articles[0];
  const meta = categoryMeta(cluster.category);

  return (
    <article className={`slab flex flex-col bg-paper ${meta.shadow}`}>
      {/* clickable image (or NO-IMAGE placeholder when the article has none) */}
      <button
        type="button"
        onClick={() => onOpen(cluster)}
        aria-label={`Open details: ${cluster.keyPhrase}`}
        className="block w-full border-b-2 border-ink text-left group"
      >
        <div className={hero?.imageUrl ? "relative overflow-hidden" : "relative"}>
          {hero?.imageUrl ? (
            <HeroImage src={hero.imageUrl} site={hero.url} eager={eager} />
          ) : (
            <div className="no-img aspect-video text-2xl">NO IMAGE</div>
          )}
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
          <SourceCountBadge count={sourceCount} className="gap-1" />
          <span className="text-[10px] uppercase tracking-widest text-ink/50">
            {timeAgo(cluster.seenAt)}
          </span>
        </div>
      </div>
    </article>
  );
}