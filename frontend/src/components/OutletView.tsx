import { useEffect, useState } from "react";
import type { Cluster, OutletResponse } from "../types";
import { toneClass } from "../types";
import { StoryCard } from "./StoryCard";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

/**
 * Outlet page — every framed story involving an outlet, backed by the
 * server-side /api/outlets/:name aggregates. The name is already decoded
 * by App; the fetch re-encodes it for the URL.
 *
 * Note: the radar's per-outlet keys come from Gemini toneTags and can
 * differ from the canonical article `source` values, so an outlet page can
 * legitimately be empty — the empty state says so.
 */
export function OutletView({
  name,
  onOpen,
  onBack,
  isSaved,
  onToggleSave,
}: {
  name: string;
  onOpen: (c: Cluster) => void;
  onBack: () => void;
  isSaved: (id: string) => boolean;
  onToggleSave: (c: Cluster) => void;
}) {
  const [data, setData] = useState<OutletResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    setData(null);
    fetch(`${API_BASE}/api/outlets/${encodeURIComponent(name)}?limit=50`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((body: OutletResponse) => {
        if (alive) setData(body);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [name]);

  if (failed) {
    return (
      <div className="slab--flat border-alarm bg-alarm/10 p-6 text-paper">
        <p className="stamp stamp--alarm">Connection error</p>
        <p className="mt-3 font-display text-lg uppercase">
          Couldn't load {name}
        </p>
        <p className="mt-1 text-sm">
          The backend didn't respond — try again shortly.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="slab--flat border-dashed p-8 text-center">
        <p className="font-display text-lg uppercase">Loading {name}…</p>
      </div>
    );
  }

  // Tone chips: highest-count first, capped at 4.
  const tones = Object.entries(data.stat.tones)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const spunPct = Math.round(data.stat.spinRatio * 100);

  return (
    <section aria-label={`Stories from ${name}`}>
      <div className="mb-5">
        <button
          type="button"
          onClick={onBack}
          className="stamp bg-paper text-ink transition-transform hover:-translate-y-0.5"
        >
          ← Back to radar
        </button>
      </div>

      <div className="slab--flat border-2 border-ink p-5">
        <h2 className="font-display text-2xl uppercase leading-tight">
          {name}
        </h2>
        <p className="mt-2 text-[11px] uppercase tracking-widest text-ink/60">
          {data.stat.frames} framed stories · {data.stat.spun} spun (
          {spunPct}%)
        </p>
        {tones.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {tones.map(([tone, count]) => (
              <span
                key={tone}
                className={`tone-chip border border-ink px-1.5 py-0.5 text-[9px] font-bold uppercase ${toneClass(tone)}`}
              >
                {tone} ×{count}
              </span>
            ))}
          </div>
        )}
      </div>

      {data.clusters.length === 0 ? (
        <div className="slab--flat border-dashed p-8 text-center">
          <p className="font-display text-lg uppercase">
            No stories from {name} yet
          </p>
          <p className="mt-2 text-sm text-ink/70">
            Radar keys come from Gemini tone labels and can differ from
            outlet names — try the full radar instead.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {data.clusters.map((c, i) => (
              <StoryCard
                key={c.id}
                cluster={c}
                onOpen={onOpen}
                eager={i === 0}
                saved={isSaved(c.id)}
                onToggleSave={onToggleSave}
              />
            ))}
          </div>
          {data.hasMore && (
            <p className="mt-6 text-center text-[11px] uppercase tracking-widest text-ink/60">
              Showing the 50 most recent — load more coming soon.
            </p>
          )}
        </>
      )}
    </section>
  );
}