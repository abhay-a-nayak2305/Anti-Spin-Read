import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useBookmarks } from "./useBookmarks";

beforeEach(() => {
  localStorage.clear();
});

describe("useBookmarks", () => {
  it("toggles a bookmark on and off, persisting immediately", () => {
    const { result } = renderHook(() => useBookmarks());

    expect(result.current.saved).toEqual([]);

    act(() => result.current.toggle("c1"));
    expect(result.current.saved).toEqual(["c1"]);
    expect(result.current.isSaved("c1")).toBe(true);
    expect(localStorage.getItem("asr.bookmarks")).toBe('["c1"]');

    act(() => result.current.toggle("c1"));
    expect(result.current.saved).toEqual([]);
    expect(result.current.isSaved("c1")).toBe(false);
    expect(localStorage.getItem("asr.bookmarks")).toBe("[]");
  });

  it("keeps multiple bookmarks and removes only the toggled one", () => {
    const { result } = renderHook(() => useBookmarks());
    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });
    expect(result.current.saved).toEqual(["a", "b"]);

    act(() => result.current.toggle("a"));
    expect(result.current.saved).toEqual(["b"]);
    expect(localStorage.getItem("asr.bookmarks")).toBe('["b"]');
  });

  it("loads existing bookmarks from localStorage on mount", () => {
    localStorage.setItem("asr.bookmarks", '["c1","c2"]');
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.saved).toEqual(["c1", "c2"]);
    expect(result.current.isSaved("c2")).toBe(true);
    expect(result.current.isSaved("missing")).toBe(false);
  });

  it("resets to an empty list on corrupt JSON", () => {
    localStorage.setItem("asr.bookmarks", "{not json at all");
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.saved).toEqual([]);

    // A follow-up write repairs the storage with a valid value.
    act(() => result.current.toggle("c1"));
    expect(localStorage.getItem("asr.bookmarks")).toBe('["c1"]');
  });

  it("resets to an empty list when the stored value is not an array", () => {
    localStorage.setItem("asr.bookmarks", '"just-a-string"');
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.saved).toEqual([]);
  });

  it("drops non-string entries from a mixed array", () => {
    localStorage.setItem("asr.bookmarks", '["c1", 42, null]');
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.saved).toEqual(["c1"]);
  });

  it("syncs across tabs via the storage event", () => {
    const { result } = renderHook(() => useBookmarks());
    expect(result.current.saved).toEqual([]);

    // Simulates another tab writing bookmarks.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "asr.bookmarks",
          newValue: '["c3","c4"]',
        })
      );
    });
    expect(result.current.saved).toEqual(["c3", "c4"]);
    expect(result.current.isSaved("c3")).toBe(true);

    // A removal in another tab clears the list.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "asr.bookmarks", newValue: null })
      );
    });
    expect(result.current.saved).toEqual([]);
  });

  it("ignores storage events for other keys", () => {
    localStorage.setItem("asr.bookmarks", '["keep"]');
    const { result } = renderHook(() => useBookmarks());

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "asr.newSince",
          newValue: '"2026-08-17T00:00:00Z"',
        })
      );
    });
    expect(result.current.saved).toEqual(["keep"]);
  });
});