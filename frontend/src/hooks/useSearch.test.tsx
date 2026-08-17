import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "./useSearch";
import type { Cluster } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function makeCluster(id: string): Cluster {
  return {
    id,
    keyPhrase: `Story ${id}`,
    category: "world",
    seenAt: "2026-08-15T12:00:00Z",
    framedAt: "2026-08-15T12:00:00Z",
    framingError: null,
    framing: null,
    articles: [],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSearch", () => {
  it("searches and stores the results", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        query: "assad",
        limit: 50,
        hasMore: false,
        clusters: [makeCluster("1")],
      })
    );
    const { result } = renderHook(() => useSearch());

    await act(async () => {
      await result.current.search("assad");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/search?q=assad&limit=50");
    expect(result.current.q).toBe("assad");
    expect(result.current.searching).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.clusters).toHaveLength(1);
    expect(result.current.clusters[0]?.id).toBe("1");
  });

  it("drops a stale response that resolves after a newer query", async () => {
    let release: (r: unknown) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () => new Promise((res) => { release = res; })
      )
      .mockResolvedValue(
        jsonResponse({
          query: "trump",
          limit: 50,
          hasMore: false,
          clusters: [makeCluster("2")],
        })
      );
    const { result } = renderHook(() => useSearch());

    const first = result.current.search("assad");
    const second = result.current.search("trump");
    await act(async () => {
      await second;
    });
    expect(result.current.clusters[0]?.id).toBe("2");

    // The stale first response lands late — it must NOT replace the results.
    await act(async () => {
      release(
        jsonResponse({
          query: "assad",
          limit: 50,
          hasMore: false,
          clusters: [makeCluster("1")],
        })
      );
      await first;
    });
    expect(result.current.clusters[0]?.id).toBe("2");
    expect(result.current.q).toBe("trump");
  });

  it("ignores queries shorter than 2 characters", async () => {
    const { result } = renderHook(() => useSearch());
    await act(async () => {
      await result.current.search("x");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.q).toBe("");
  });

  it("clears back to the idle state", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ query: "assad", limit: 50, hasMore: false, clusters: [makeCluster("1")] })
    );
    const { result } = renderHook(() => useSearch());
    await act(async () => {
      await result.current.search("assad");
    });
    expect(result.current.q).toBe("assad");

    act(() => result.current.clear());
    expect(result.current.q).toBe("");
    expect(result.current.clusters).toHaveLength(0);
    expect(result.current.searching).toBe(false);
  });

  it("surfaces fetch failures as an error, keeping the query", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useSearch());
    await act(async () => {
      await result.current.search("assad");
    });
    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.q).toBe("assad");
    expect(result.current.searching).toBe(false);
  });
});