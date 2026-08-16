import { useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StoryCard } from "./components/StoryCard";
import { StoryModal } from "./components/StoryModal";
import { useClusters } from "./hooks/useClusters";
import type { CategoryId, Cluster } from "./types";
import { CATEGORY_META, CATEGORY_ORDER, categoryMeta } from "./types";

function CategoryFilter({
  active,
  counts,
  onChange,
}: {
  active: CategoryId | "all";
  counts: Record<string, number>;
  onChange: (c: CategoryId | "all") => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Filter stories by category"
    >
      <button
        type="button"
        onClick={() => onChange("all")}
        aria-pressed={active === "all"}
        className={`stamp text-[11px] transition-transform hover:-translate-y-0.5 ${
          active === "all" ? "bg-ink text-paper" : "bg-paper text-ink"
        }`}
      >
        ALL
      </button>
      {CATEGORY_ORDER.map((id) => {
        const meta = CATEGORY_META[id];
        const count = counts[id] ?? 0;
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(isActive ? "all" : id)}
            aria-pressed={isActive}
            className={`stamp text-[11px] transition-transform hover:-translate-y-0.5 ${
              isActive ? "bg-ink text-paper" : meta.stamp
            }`}
          >
            {meta.label}
            {count > 0 && (
              <span
                className={`ml-1.5 ${
                  isActive ? "text-acid" : "text-ink/50"
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function App() {
  const { data, loading, error, hasMore, loadingMore, loadMore, newSince, refresh } =
    useClusters();
  const clusters = useMemo(() => data?.clusters ?? [], [data]);
  const framed = useMemo(() => clusters.filter((c) => c.framing), [clusters]);

  // Stories that appeared since the last acknowledged watermark.
  const newCount = useMemo(() => {
    if (newSince === null) return 0;
    return clusters.filter((c) => c.seenAt > newSince).length;
  }, [clusters, newSince]);

  // URL-synced filter: initialize from ?category=… (valid ids only) and
  // keep the address bar in sync via replaceState so Back stays sane.
  const [filter, setFilter] = useState<CategoryId | "all">(() => {
    const param = new URLSearchParams(window.location.search).get("category");
    return param && CATEGORY_META[param as CategoryId]
      ? (param as CategoryId)
      : "all";
  });
  const updateFilter = useCallback((next: CategoryId | "all") => {
    setFilter(next);
    const url =
      next === "all" ? window.location.pathname : `?category=${next}`;
    window.history.replaceState(null, "", url);
  }, []);
  const [selected, setSelected] = useState<Cluster | null>(null);

  const openModal = useCallback((c: Cluster) => setSelected(c), []);
  const closeModal = useCallback(() => setSelected(null), []);

  // Per-category counts across ALL clusters (not just the filtered view)
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const cl of clusters) c[cl.category] = (c[cl.category] ?? 0) + 1;
    return c;
  }, [clusters]);

  const visible = useMemo(
    () => (filter === "all" ? clusters : clusters.filter((c) => c.category === filter)),
    [clusters, filter]
  );

  return (
    <div className="min-h-screen">
      <ErrorBoundary>
        <header className="border-b-4 border-ink bg-ink">
          <div className="max-w-6xl mx-auto px-4 py-8">
            <div className="flex items-start gap-4">
              <div>
                <h1 className="font-display text-4xl sm:text-5xl uppercase leading-none tracking-tight">
                  The Anti-Spin{" "}
                  <span className="text-acid">Read</span>
                </h1>
                <p className="mt-3 text-xs sm:text-sm text-paper/80 uppercase tracking-widest">
                  The same story, told differently by different outlets — read
                  the difference.
                </p>
              </div>
            </div>
          </div>
        </header>
      </ErrorBoundary>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {newSince !== null && (
          <div className="mb-5 flex items-center justify-between">
            {newCount > 0 ? (
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label={`${newCount} new ${newCount === 1 ? "story" : "stories"} — click to refresh and mark read`}
                className="flex items-center gap-2 border-2 border-ink bg-acid px-3 py-1.5 font-display text-[11px] uppercase tracking-wide shadow-[4px_4px_0_var(--color-ink)] transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-1 active:translate-y-1"
              >
                <span className="h-2 w-2 rounded-full bg-alarm" aria-hidden="true" />
                {newCount} new {newCount === 1 ? "story" : "stories"} — click to mark read
              </button>
            ) : (
              <p className="text-[11px] uppercase tracking-widest text-ink/50">
                You're all caught up
              </p>
            )}
          </div>
        )}

        <CategoryFilter active={filter} counts={counts} onChange={updateFilter} />

        <div className="mt-8 space-y-8">
          {loading && (
            <div className="slab--flat border-dashed p-8 text-center">
              <p className="font-display text-lg uppercase">
                Loading fresh stories…
              </p>
            </div>
          )}

          {error && (
            <div className="slab--flat border-alarm bg-alarm/10 p-6 text-paper">
              <p className="stamp stamp--alarm">Connection error</p>
              <p className="mt-3 font-display text-lg uppercase">
                Couldn't reach the backend
              </p>
              <p className="mt-1 text-sm">{error}</p>
              <p className="mt-2 text-sm text-paper/70">
                Is the API running at{" "}
                <code className="border border-paper px-1">
                  {import.meta.env.VITE_API_BASE || "/api"}
                </code>
                ?
              </p>
            </div>
          )}

          {!loading && !error && clusters.length === 0 && (
            <div className="slab--flat border-dashed p-8 text-center">
              <p className="font-display text-lg uppercase">
                No stories yet
              </p>
              <p className="mt-2 text-sm text-ink/70">
                The pipeline runs every 15 minutes — check back shortly.
              </p>
            </div>
          )}

          {framed.length === 0 && clusters.length > 0 && (
            <div className="slab--flat border-dashed p-4 text-center text-sm">
              <p>
                <span className="stamp stamp--pending">Framing</span>{" "}
                <span className="text-ink/80">
                  Stories found — framing reports are being generated.
                </span>
              </p>
            </div>
          )}

          {!loading && !error && visible.length === 0 && clusters.length > 0 && filter !== "all" && (
            <div className="slab--flat border-dashed p-8 text-center">
              <p className="font-display text-lg uppercase">
                No stories in{" "}
                <span className={categoryMeta(filter).text}>
                  {CATEGORY_META[filter].label}
                </span>
              </p>
              <p className="mt-2 text-sm text-ink/70">
                Pick another category or hit ALL.
              </p>
            </div>
          )}

          {visible.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
              {visible.map((c, i) => (
                <StoryCard
                  key={c.id}
                  cluster={c}
                  onOpen={openModal}
                  eager={i === 0}
                  isNew={newSince !== null && c.seenAt > newSince}
                />
              ))}
            </div>
          )}

          {hasMore && visible.length > 0 && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="slab px-6 py-3 font-display text-sm uppercase tracking-wide transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-1 active:translate-y-1 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="border-t-4 border-ink">
        <div className="max-w-6xl mx-auto px-4 py-4 text-center text-[11px] uppercase tracking-widest text-paper/60">
          Headlines link to original articles · Google News RSS · Framing by
          Gemini · Updated every 15 minutes
        </div>
      </footer>

      {selected && <StoryModal cluster={selected} onClose={closeModal} />}
    </div>
  );
}