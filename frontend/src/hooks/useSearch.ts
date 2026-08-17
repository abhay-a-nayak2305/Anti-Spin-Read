import { useCallback, useRef, useState } from "react";
import type { Cluster, SearchResponse } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface SearchState {
  /** Active query ("" = no search active). */
  q: string;
  searching: boolean;
  error: string | null;
  clusters: Cluster[];
  hasMore: boolean;
}

/**
 * Debounce-free, superseded search against /api/search.
 *
 * - `search(q)` with a valid query (≥2 chars) fetches and replaces results;
 *   a monotonic sequence id drops stale responses that arrive after a newer
 *   query (or after clear).
 * - `clear()` resets to the normal grid. Invalid/short input clears too,
 *   so an emptied box never leaves stale results on screen.
 */
export function useSearch() {
  const [state, setState] = useState<SearchState>({
    q: "",
    searching: false,
    error: null,
    clusters: [],
    hasMore: false,
  });
  const seq = useRef(0);

  const search = useCallback(async (raw: string) => {
    const query = raw.trim();
    if (query.length < 2) {
      seq.current++;
      setState({ q: "", searching: false, error: null, clusters: [], hasMore: false });
      return;
    }
    const mySeq = ++seq.current;
    setState((s) => ({ ...s, q: query, searching: true, error: null }));
    try {
      const res = await fetch(
        `${API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=50`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SearchResponse;
      if (seq.current !== mySeq) return; // superseded — drop it
      setState({
        q: query,
        searching: false,
        error: null,
        clusters: body.clusters,
        hasMore: body.hasMore,
      });
    } catch (err) {
      if (seq.current !== mySeq) return;
      setState((s) => ({
        ...s,
        q: query,
        searching: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  const clear = useCallback(() => {
    seq.current++;
    setState({ q: "", searching: false, error: null, clusters: [], hasMore: false });
  }, []);

  return { ...state, search, clear };
}