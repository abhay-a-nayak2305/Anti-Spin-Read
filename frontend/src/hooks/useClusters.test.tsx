import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClusters } from "./useClusters";
import type { Cluster, ClustersResponse } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function makeCluster(id: string): Cluster {
  return {
    id,
    keyPhrase: `Story ${id}`,
    category: "world",
    seenAt: "2026-08-15T00:00:00Z",
    framedAt: "2026-08-15T00:00:00Z",
    framingError: null,
    framing: null,
    articles: [],
  };
}

/** Response fixture matching the live API contract. */
function makeResponse(
  clusters: Cluster[],
  hasMore = false,
  offset = 0
): ClustersResponse {
  return { limit: 50, offset, hasMore, clusters };
}

/** Stub document.hidden and return a restore function. */
function stubDocumentHidden(hidden: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  return () => {
    if (original) {
      Object.defineProperty(document, "hidden", original);
    } else {
      delete (document as { hidden?: unknown }).hidden;
    }
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useClusters", () => {
  it("loads clusters on mount and exposes them", async () => {
    const body = makeResponse([makeCluster("a")]);
    fetchMock.mockResolvedValue(jsonResponse(body));

    const { result } = renderHook(() => useClusters());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(body);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The initial load is always the first page.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("limit=50&offset=0"),
      expect.anything()
    );
  });

  it("does not let a stale slow response overwrite newer data", async () => {
    let resolveSlow!: (value: unknown) => void;
    let resolveFast!: (value: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((res) => (resolveSlow = res)))
      .mockImplementationOnce(() => new Promise((res) => (resolveFast = res)));

    const { result } = renderHook(() => useClusters());

    // Manual refresh supersedes the still-pending initial load.
    act(() => {
      void result.current.refresh();
    });

    const fresh = makeResponse([makeCluster("fresh")]);
    await act(async () => {
      resolveFast(jsonResponse(fresh));
    });
    await waitFor(() => expect(result.current.data).toEqual(fresh));

    // The slow initial response lands AFTER the refresh — it must be dropped.
    const stale = makeResponse([makeCluster("stale")]);
    await act(async () => {
      resolveSlow(jsonResponse(stale));
    });
    expect(result.current.data).toEqual(fresh);
  });

  it("clears loading, sets error, and backs off before the next poll", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useClusters());
    await act(async () => {}); // initial load settles

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1); // backoff is 1s — not yet

    vi.advanceTimersByTime(600); // 1.1s since the failure
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2); // retry after the 1s backoff
  });

  it("aborts the in-flight request on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise(() => {}); // never resolves
    });

    const { unmount } = renderHook(() => useClusters());
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    unmount();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("skips automatic polling while the document is hidden", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeResponse([])));
    const restoreHidden = stubDocumentHidden(true);
    try {
      const { unmount } = renderHook(() => useClusters());
      await act(async () => {}); // initial load succeeds
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000); // next poll is due…
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledTimes(1); // …but the tab is hidden — skipped

      restoreHidden(); // tab becomes visible again
      vi.advanceTimersByTime(60_000); // a full poll cycle
      await act(async () => {});
      expect(fetchMock).toHaveBeenCalledTimes(2); // polling resumes
      unmount();
    } finally {
      restoreHidden();
    }
  });

  it("loadMore appends the next page and dedupes clusters by id", async () => {
    const page1 = makeResponse(
      Array.from({ length: 50 }, (_, i) => makeCluster(`p1-${i}`)),
      true
    );
    // The feed shifted between polls: 5 of page 1's clusters reappear here.
    const page2 = makeResponse(
      [
        ...page1.clusters.slice(0, 5),
        ...Array.from({ length: 45 }, (_, i) => makeCluster(`p2-${i}`)),
      ],
      false,
      50
    );

    let resolvePage2!: (value: unknown) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockImplementationOnce(() => new Promise((res) => (resolvePage2 = res)));

    const { result } = renderHook(() => useClusters());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.clusters).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);

    let done = false;
    act(() => {
      void result.current.loadMore().then(() => (done = true));
    });
    expect(result.current.loadingMore).toBe(true); // in-flight flag exposed

    await act(async () => {
      resolvePage2(jsonResponse(page2));
    });
    expect(done).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    // 50 existing + 45 new; the 5 duplicates were dropped.
    expect(result.current.data?.clusters).toHaveLength(95);
    expect(result.current.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("limit=50&offset=50"),
      expect.anything()
    );
  });

  it("refresh resets appended state back to the first page", async () => {
    const page1 = makeResponse(
      Array.from({ length: 50 }, (_, i) => makeCluster(`p1-${i}`)),
      true
    );
    const page2 = makeResponse(
      Array.from({ length: 25 }, (_, i) => makeCluster(`p2-${i}`)),
      false,
      50
    );
    const refreshed = makeResponse(
      Array.from({ length: 50 }, (_, i) => makeCluster(`r-${i}`)),
      true
    );

    fetchMock
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
      .mockResolvedValueOnce(jsonResponse(refreshed));

    const { result } = renderHook(() => useClusters());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.data?.clusters).toHaveLength(75);

    // Manual refresh replaces everything with a fresh first page.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.data?.clusters).toHaveLength(50);
    expect(result.current.data?.clusters[0].id).toBe("r-0");
    expect(result.current.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("limit=50&offset=0"),
      expect.anything()
    );
  });
});