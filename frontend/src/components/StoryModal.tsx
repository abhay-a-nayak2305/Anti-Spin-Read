import { useEffect, useRef, useState } from "react";
import type { Cluster } from "../types";
import { categoryMeta, faviconUrl, timeAgo, toneClass } from "../types";
import { HeroImage } from "./HeroImage";
import { LetterBadge } from "./LetterBadge";
import { SourceCountBadge, ToneChip } from "./badges";

/**
 * Article thumbnail with the same privacy-preserving chain as the hero:
 * og:image → site favicon → inline SVG letter monogram. The img declares
 * its intrinsic 40×40 size so the row reserves space before load.
 */
function ArticleThumb({
  imageUrl,
  site,
}: {
  imageUrl: string;
  site: string;
}) {
  const [srcIndex, setSrcIndex] = useState(0);
  const candidates = imageUrl
    ? [imageUrl, faviconUrl(site)].filter(Boolean)
    : [faviconUrl(site)].filter(Boolean);
  const current = candidates[srcIndex];
  const exhausted = srcIndex >= candidates.length;

  if (exhausted) {
    return (
      <LetterBadge
        site={site}
        className="mt-0.5 h-10 w-10 shrink-0 border-2 border-ink"
      />
    );
  }
  return (
    <img
      src={current}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setSrcIndex((i) => i + 1)}
      className="mt-0.5 h-10 w-10 shrink-0 object-cover border-2 border-ink grayscale contrast-125"
    />
  );
}

function Section({
  title,
  accent,
  children,
}: {
  title: string;
  /** stamp--alarm for omission sections; default is the story's category fill. */
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t-4 border-ink pt-4 mt-6">
      <h4 className={`stamp ${accent} mb-3 text-[11px]`}>{title}</h4>
      <ul className="space-y-2.5">{children}</ul>
    </section>
  );
}

/**
 * Full story details in a centered slab over a dimmed backdrop.
 * Closed via the ✕ button, clicking (not dragging) the dimmed backdrop, or
 * Escape. Focus is trapped inside the panel and returned to the trigger
 * element on close.
 */
export function StoryModal({
  cluster,
  onClose,
  saved = false,
  onToggleSave,
}: {
  cluster: Cluster;
  onClose: () => void;
  /** Story is in the reader's saved bookmarks. */
  saved?: boolean;
  /** Wired by App — omitted in tests and standalone usage → no heart button. */
  onToggleSave?: (c: Cluster) => void;
}) {
  const f = cluster.framing;
  const sourceCount = cluster.articles.length;
  const hero = cluster.articles[0];
  const meta = categoryMeta(cluster.category);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Lock page scroll, close on Escape, focus the panel, and return focus to
  // the previously focused element on unmount.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.classList.add("modal-open");
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
      previouslyFocused?.focus();
    };
  }, [onClose]);

  // Cycle Tab / Shift+Tab among the panel's focusable elements so focus
  // never escapes into the page behind the modal.
  const trapTabFocus = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={cluster.keyPhrase}
      onKeyDown={trapTabFocus}
      // Drag-aware backdrop close: only close on a click (pointer moved
      // < 6px), so scroll-dragging the overlay doesn't dismiss the modal.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          dragStartRef.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onPointerUp={(e) => {
        const start = dragStartRef.current;
        dragStartRef.current = null;
        if (e.target !== e.currentTarget || !start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) < 6) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`modal-panel slab bg-paper outline-none ${meta.shadow} ${meta.border}`}
        style={{ "--cat": meta.selection } as React.CSSProperties}
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b-4 border-ink px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
              <span className={`stamp ${meta.stamp} text-[11px]`}>
                {meta.label}
              </span>
              {onToggleSave && (
                <button
                  type="button"
                  onClick={() => onToggleSave(cluster)}
                  aria-label={saved ? "Unsave story" : "Save story"}
                  aria-pressed={saved}
                  title={saved ? "Unsave story" : "Save story"}
                  className={`border-none bg-transparent p-0 text-[11px] leading-none transition-colors hover:text-alarm ${
                    saved ? "text-alarm" : "text-ink/40"
                  }`}
                >
                  ♥
                </button>
              )}
              <SourceCountBadge count={sourceCount} className="gap-1.5" />
              <span className="text-[11px] uppercase tracking-widest text-ink/60">
                {timeAgo(cluster.seenAt)}
              </span>
            </div>
            <h2 className="font-display text-xl sm:text-2xl leading-tight">
              {cluster.keyPhrase}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close story details"
            className="shrink-0 border-2 border-ink px-2.5 py-1 font-display text-xl leading-none hover:bg-ink hover:text-paper"
          >
            ✕
          </button>
        </div>

        {/* body */}
        <div className="px-5 pb-6">
          {hero?.imageUrl && (
            <figure className="mt-5 border-2 border-ink">
              <HeroImage src={hero.imageUrl} site={hero.url} />
              <figcaption className="flex items-center justify-between gap-2 bg-ink px-2 py-1.5 text-[10px] uppercase tracking-widest text-paper">
                <span className="truncate">
                  IMG: {hero.source} — {hero.title}
                </span>
              </figcaption>
            </figure>
          )}

          {f === null && cluster.framingError && (
            <div className="mt-5 border-2 border-alarm bg-alarm/10 p-4">
              <p className="stamp stamp--alarm">Framing failed</p>
              <p className="mt-2 text-sm leading-relaxed text-ink/85">
                The framing report for this story failed to generate. It will
                be retried automatically on a later run — the raw news below
                is still worth reading.
              </p>
            </div>
          )}

          {f === null && !cluster.framingError && (
            <div className="mt-5 border-2 border-dashed border-ink p-4">
              <p className="stamp stamp--pending">Framing in progress</p>
              <p className="mt-2 text-sm leading-relaxed text-ink/85">
                The framing report is being generated — new reports land
                within ~15 minutes. The raw news below is already here.
              </p>
            </div>
          )}

          {f && (
            <Section title="How the coverage differs" accent={meta.fill}>
              {f.headlineDeltas.map((d, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span className="text-ink/40 shrink-0" aria-hidden>▸</span>
                  <span>{d}</span>
                </li>
              ))}
            </Section>
          )}

          {f && f.notableOmissions.length > 0 && (
            <Section title="What some outlets left out" accent="stamp--alarm">
              {f.notableOmissions.map((o, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span className="text-alarm shrink-0" aria-hidden>✕</span>
                  <span>{o}</span>
                </li>
              ))}
            </Section>
          )}

          {f && (
            <Section title="Tone by outlet" accent={meta.fill}>
              <div className="flex flex-wrap gap-2">
                {f.toneTags.map((t, i) => (
                  <ToneChip
                    key={i}
                    source={t.source}
                    tone={t.tone}
                    className="px-2 py-0.5 text-xs"
                  />
                ))}
              </div>
            </Section>
          )}

          {f && (
            <div
              className={`mt-6 border-2 border-ink ${meta.fill} p-4 shadow-[4px_4px_0_var(--color-ink)]`}
            >
              <p className="text-sm leading-relaxed">
                <span className="font-display uppercase">The story: </span>
                {f.neutralSummary}
              </p>
            </div>
          )}

          <Section title="The news, outlet by outlet" accent={meta.fill}>
            {cluster.articles.map((a) => {
              const tone = f?.toneTags.find((t) => t.source === a.source);
              return (
                <li key={a.source} className="border-2 border-ink">
                  {/* outlet header */}
                  <div className="flex items-center justify-between gap-2 border-b-2 border-ink bg-ink px-3 py-2">
                    <span className="font-display text-sm uppercase tracking-wide text-paper">
                      {a.source}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-widest text-paper/60">
                      {timeAgo(a.publishedAt)}
                    </span>
                  </div>

                  <div className="p-3">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2.5 group"
                    >
                      <ArticleThumb imageUrl={a.imageUrl} site={a.url} />
                      <span className="font-display text-sm leading-snug text-ink group-hover:underline group-hover:underline-offset-2">
                        {a.title}
                      </span>
                    </a>

                    {/* the actual news text */}
                    <p className="mt-2.5 border-l-4 border-ink/15 pl-3 text-[13px] leading-relaxed text-ink/85">
                      {a.lede || "No excerpt available — read the full article."}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      {tone ? (
                        <span
                          className={`tone-chip border-2 border-ink px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${toneClass(tone.tone)}`}
                        >
                          Tone: {tone.tone}
                        </span>
                      ) : (
                        <span aria-hidden />
                      )}
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`stamp ${meta.fill} text-[10px] hover:bg-ink hover:text-paper`}
                      >
                        READ FULL ARTICLE →
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </Section>
        </div>
      </div>
    </div>
  );
}