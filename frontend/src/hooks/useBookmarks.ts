import { useCallback, useEffect, useState } from "react";

/**
 * Saved-story bookmarks, persisted as a list of cluster ids in localStorage
 * (`asr.bookmarks`). Ids only — a full cluster would go stale the moment the
 * 14-day retention prunes it, and App refetches missing ids anyway.
 *
 * - Read once on mount (lazy state init); written on every change.
 * - Missing/corrupt JSON resets to an empty list.
 * - A `storage` event (another tab) replaces the in-memory list, so tabs
 *   stay in sync for free.
 */
const BOOKMARKS_KEY = "asr.bookmarks";

function parseRaw(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return []; // corrupt JSON — start clean
  }
}

function readBookmarks(): string[] {
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_KEY);
    return raw === null ? [] : parseRaw(raw);
  } catch {
    return []; // storage unavailable (private mode)
  }
}

export interface Bookmarks {
  saved: string[];
  isSaved(id: string): boolean;
  /** Adds or removes the id and persists immediately. */
  toggle(id: string): void;
}

export function useBookmarks(): Bookmarks {
  const [saved, setSaved] = useState<string[]>(readBookmarks);

  // Persist on every change (writes are cheap; best-effort when storage is
  // unavailable, e.g. private mode).
  useEffect(() => {
    try {
      window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(saved));
    } catch {
      /* bookmarks just won't survive a reload */
    }
  }, [saved]);

  // Cross-tab sync: another tab's write arrives as a storage event (never
  // fires in the tab that made the change, so no echo loop). The event
  // carries the new value directly — reading localStorage here would race
  // the writer in tests and exotic browsers.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== BOOKMARKS_KEY) return;
      setSaved(e.newValue === null ? [] : parseRaw(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isSaved = useCallback((id: string) => saved.includes(id), [saved]);

  const toggle = useCallback((id: string) => {
    setSaved((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  return { saved, isSaved, toggle };
}