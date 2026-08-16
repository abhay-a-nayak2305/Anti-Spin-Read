import { useCallback, useEffect, useRef, useState } from "react";
import type { Cluster, ClustersResponse } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const PAGE_SIZE = 50;
const POLL_INTERVAL = 60_000; // normal cadence between successful polls
const BACKOFF_BASE = 1_000; // first retry delay after a failed poll
const BACKOFF_CAP = 60_000; // backoff grows 1s, 2s, 4s, 8s … capped here

/**
 * "New since your last visit" watermark — the newest `seenAt` the user has
 * explicitly acknowledged. Persisted so a later page load knows what the
 * previous visit already showed. ISO timestamps compare lexicographically.
 */
const NEW_SINCE_KEY = "asr.newSince";

function readWatermark(): string | null {
  try {
    return window.localStorage.getItem(NEW_SINCE_KEY);
  } catch {
    return null; // storage unavailable (private mode) — no watermark, no badges
  }
}

function writeWatermark(iso: string): void {
  try {
    window.localStorage.setItem(NEW_SINCE_KEY, iso);
  } catch {
    /* best-effort: badges just won't persist across reloads */
  }
}

/** Newest `seenAt` across the page, or null for an empty page. */
function maxSeenAt(clusters: Cluster[]): string | null {
  let max: string | null = null;
  for (const c of clusters) {
    if (typeof c.seenAt === "string" && (max === null || c.seenAt > max)) {
      max = c.seenAt;
    }
  }
  return max;
}

/** Append `incoming` to `existing`, dropping clusters whose id is already present. */
function mergeClusters(existing: Cluster[], incoming: Cluster[]): Cluster[] {
  const seen = new Set(existing.map((c) => c.id));
  return [...existing, ...incoming.filter((c) => !seen.has(c.id))];
}

/**
 * Cluster polling with request supersession, exponential backoff, and
 * "load more" pagination.
 *
 * - Every fetch aborts the previous in-flight request (supersede), and a
 *   monotonic request id guards against stale responses applying late.
 * - Page fetches (`replace` mode) always hit offset 0 — initial load, polls
 *   and manual refresh replace the whole list with the newest page.
 * - loadMore (`append` mode) fetches the next page at the current count and
 *   merges it in, deduping by cluster id (the feed can shift between polls).
 * - Failed polls retry with exponential backoff (1s → 2s → 4s → … capped at
 *   60s). A successful poll resets the backoff and resumes the 60s cadence.
 * - Automatic polls are skipped while the tab is hidden; manual refresh
 *   always fetches.
 * - "New since your last visit": `newSince` is the newest `seenAt` the user
 *   has acknowledged. It advances ONLY on manual refresh (initial loads and
 *   auto-polls leave it alone), so stories that appear while the page is
 *   open keep their NEW badge until the user explicitly refreshes.
 */
export function useClusters() {
  const [data, setData] = useState<ClustersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Watermark from the previous visit (persisted), or null on a first visit.
  const [newSince, setNewSince] = useState<string | null>(readWatermark);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const nextDelayRef = useRef(BACKOFF_BASE);
  // Mirror of the latest applied response — lets loadMore read the current
  // count synchronously without a stale closure on `data`.
  const dataRef = useRef<ClustersResponse | null>(null);
  const countRef = useRef(0); // clusters currently held → next append offset

  /** @returns true when the request succeeded or was superseded (not an error). */
  const fetchPage = useCallback(
    async (
      offset: number,
      mode: "replace" | "append",
      silent = false,
      markSeen = false
    ): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestIdRef.current;

      if (mode === "append") setLoadingMore(true);
      else if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `${API_BASE}/api/clusters?limit=${PAGE_SIZE}&offset=${offset}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ClustersResponse;
        if (requestId !== requestIdRef.current) return true; // stale response — drop it

        if (mode === "append") {
          // Merge onto the current list, dropping ids we already hold — the
          // feed can shift between polls, so the same story may reappear.
          const merged: ClustersResponse = {
            ...body,
            clusters: mergeClusters(dataRef.current?.clusters ?? [], body.clusters),
          };
          dataRef.current = merged;
          setData(merged);
          countRef.current = merged.clusters.length;
        } else {
          dataRef.current = body; // page 1 replaces everything
          setData(body);
          countRef.current = body.clusters.length;
          if (markSeen) {
            // Acknowledged: advance the watermark to the newest story on the
            // page so the NEXT batch is what counts as new.
            const max = maxSeenAt(body.clusters);
            if (max !== null) {
              setNewSince(max);
              writeWatermark(max);
            }
          }
        }
        setHasMore(body.hasMore);
        nextDelayRef.current = BACKOFF_BASE; // success resets the backoff
        return true;
      } catch (err) {
        if (controller.signal.aborted) return true; // superseded / unmounted — not an error
        if (requestId !== requestIdRef.current) return true;
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        // The current request clears every flag, so a loadMore superseded by
        // a poll can't leave loadingMore stuck on.
        if (!controller.signal.aborted && requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  /** First page (offset 0), replacing state — initial load, polls, refresh. */
  const load = useCallback(
    (silent = false, markSeen = false) => fetchPage(0, "replace", silent, markSeen),
    [fetchPage]
  );

  /** Next page at the current count, appended and deduped. */
  const loadMore = useCallback(async (): Promise<void> => {
    await fetchPage(countRef.current, "append");
  }, [fetchPage]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (cancelled) return;
        if (document.hidden) {
          // Tab hidden — skip the poll but keep waiting on the same cadence,
          // so polling resumes with the right delay once visible again.
          schedule(delay);
          return;
        }
        void poll();
      }, delay);
    };

    const continueChain = (ok: boolean) => {
      if (cancelled) return;
      if (ok) {
        schedule(POLL_INTERVAL);
      } else {
        const delay = nextDelayRef.current;
        nextDelayRef.current = Math.min(delay * 2, BACKOFF_CAP);
        schedule(delay);
      }
    };

    const poll = async () => {
      continueChain(await load(true));
    };

    // Initial load; from here the chain owns all scheduling.
    void load().then(continueChain);

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [load]);

  return {
    data,
    loading,
    error,
    refreshing,
    loadingMore,
    hasMore,
    newSince,
    refresh: () => load(true, true),
    loadMore,
  };
}