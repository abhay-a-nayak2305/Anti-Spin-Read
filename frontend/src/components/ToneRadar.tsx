import { useEffect, useState } from "react";
import type { CategoryId, ToneRadarOutlet, ToneRadarResponse } from "../types";
import { CATEGORY_META, CATEGORY_ORDER, toneClass } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

/**
 * Outlet spin radar — per-outlet share of spun framing across the last 200
 * framed stories, aggregated server-side from the toneTags the framing
 * stage already stores (a cheap, 60s edge-cached read — no extra cost).
 * Category chips narrow the same read via `?category=`. Decorative:
 * renders nothing on failure so it can never break the page.
 */
export function ToneRadar() {
  const [outlets, setOutlets] = useState<ToneRadarOutlet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<CategoryId | null>(
    null
  );

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const url = selectedCategory
      ? `${API_BASE}/api/tone-radar?category=${selectedCategory}`
      : `${API_BASE}/api/tone-radar`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: ToneRadarResponse) => {
        if (!alive) return;
        setOutlets(body.outlets);
        // Derive the active chip from the response's category echo (the
        // backend owns validation, so its word is final).
        if (body.category && body.category in CATEGORY_META) {
          setSelectedCategory(body.category as CategoryId);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [selectedCategory]);

  if (failed) return null;
  if (!outlets || outlets.length === 0) {
    return (
      <div className="slab--flat border-dashed p-6 text-center">
        <p className="font-display text-sm uppercase">
          Tone radar assembling…
        </p>
      </div>
    );
  }

  const top = outlets.slice(0, 12);
  return (
    <section
      className="slab--flat border-2 border-ink p-5"
      aria-label="Tone radar: which outlets spin the most"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-2">
        <h2 className="font-display text-sm uppercase tracking-wide">
          Tone radar — who's spinning?
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-ink/50">
          last 200 framed stories · updates every run
          {selectedCategory && ` · ${CATEGORY_META[selectedCategory].label}`}
        </span>
      </header>

      <div
        className="mt-4 flex flex-wrap gap-2"
        role="group"
        aria-label="Filter tone radar by category"
      >
        <button
          type="button"
          onClick={() => setSelectedCategory(null)}
          aria-pressed={selectedCategory === null}
          className={`stamp text-[11px] transition-transform hover:-translate-y-0.5 ${
            selectedCategory === null ? "bg-ink text-paper" : "bg-paper text-ink"
          }`}
        >
          ALL
        </button>
        {CATEGORY_ORDER.map((id) => {
          const isActive = selectedCategory === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSelectedCategory(isActive ? null : id)}
              aria-pressed={isActive}
              className={`stamp text-[11px] transition-transform hover:-translate-y-0.5 ${
                isActive ? "bg-ink text-paper" : CATEGORY_META[id].stamp
              }`}
            >
              {CATEGORY_META[id].label}
            </button>
          );
        })}
      </div>

      <ul className="mt-4 space-y-3">
        {top.map((o) => {
          const spunPct = Math.round(o.spinRatio * 100);
          const [topTone, topToneCount] =
            Object.entries(o.tones).sort((a, b) => b[1] - a[1])[0] ?? [];
          return (
            <li key={o.source} className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  // A plain hash assignment triggers the existing hashchange
                  // listener in App — no history gymnastics needed here.
                  window.location.hash = `#/outlet/${encodeURIComponent(o.source)}`;
                }}
                className="w-28 shrink-0 cursor-pointer truncate text-left font-display text-[11px] uppercase tracking-wide hover:underline hover:underline-offset-2"
              >
                {o.source}
              </button>
              <div
                className="h-3 flex-1 border-2 border-ink bg-ink/10"
                role="img"
                aria-label={`${o.source}: ${o.spun} of ${o.frames} frames spun`}
              >
                <div
                  className="h-full bg-alarm"
                  style={{ width: `${spunPct}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-[10px] uppercase tracking-widest">
                {o.spun}/{o.frames}{" "}
                <span className="text-ink/50">({spunPct}%)</span>
              </span>
              {topTone && (
                <span
                  className={`tone-chip hidden sm:inline-block border border-ink px-1.5 py-0.5 text-[9px] font-bold uppercase ${toneClass(topTone)}`}
                >
                  {topTone} ×{topToneCount}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}