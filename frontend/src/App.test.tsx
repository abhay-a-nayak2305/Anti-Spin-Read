import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Cluster } from "./types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function makeCluster(id: string, seenAt: string): Cluster {
  return {
    id,
    keyPhrase: `Story ${id}`,
    category: "world",
    seenAt,
    framedAt: "2026-08-15T12:00:00Z",
    framingError: null,
    framing: null,
    articles: [],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App — new stories banner", () => {
  it("badges stories newer than the last visit and marks them read on click", async () => {
    // The previous visit acknowledged everything up to 09:00.
    localStorage.setItem("asr.newSince", "2026-08-15T09:00:00Z");
    fetchMock.mockResolvedValue(
      jsonResponse({
        limit: 50,
        offset: 0,
        hasMore: false,
        clusters: [
          makeCluster("b", "2026-08-15T10:00:00Z"),
          makeCluster("a", "2026-08-15T08:00:00Z"),
          makeCluster("c", "2026-08-15T11:00:00Z"),
        ],
      })
    );

    render(<App />);

    // Two of the three stories arrived after the watermark.
    const chip = await screen.findByText(/2 new stories/i);
    expect(chip).toBeInTheDocument();
    expect(screen.getAllByText("New")).toHaveLength(2);

    // Clicking refreshes and advances the watermark → all caught up.
    fireEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument()
    );
    expect(screen.queryAllByText("New")).toHaveLength(0);
    expect(localStorage.getItem("asr.newSince")).toBe("2026-08-15T11:00:00Z");
  });

  it("shows no banner and no stamps on a first-ever visit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        limit: 50,
        offset: 0,
        hasMore: false,
        clusters: [makeCluster("a", "2026-08-15T10:00:00Z")],
      })
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("Story a")).toBeInTheDocument()
    );

    expect(screen.queryByText(/new stories/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    expect(screen.queryAllByText("New")).toHaveLength(0);
  });
});