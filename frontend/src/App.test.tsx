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
  // Reset any deep-link hash left behind by a test.
  window.history.replaceState(null, "", window.location.pathname);
});

/** Route fetch mocks by URL so the clusters, search and deep-link
 * endpoints each return their own shapes. */
function routeFetchMock() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes("/api/search")) {
      return Promise.resolve(
        jsonResponse({
          query: "assad",
          limit: 50,
          hasMore: false,
          clusters: [makeCluster("42", "2026-08-15T10:30:00Z")],
        })
      );
    }
    if (url.includes("/api/clusters/42")) {
      return Promise.resolve(jsonResponse(makeCluster("42", "2026-08-15T10:30:00Z")));
    }
    return Promise.resolve(
      jsonResponse({
        limit: 50,
        offset: 0,
        hasMore: false,
        clusters: [makeCluster("a", "2026-08-15T10:00:00Z")],
      })
    );
  });
}

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

describe("App — search", () => {
  it("searches, replaces the grid with results, and clears back", async () => {
    routeFetchMock();
    render(<App />);
    await screen.findByText("Story a");

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "assad" } });
    fireEvent.submit(input.closest("form")!);

    await screen.findByText(/Search: “assad”/i);
    expect(screen.getByText("Story 42")).toBeInTheDocument();
    // The grid's own story is replaced while searching.
    expect(screen.queryByText("Story a")).not.toBeInTheDocument();
    // Category filter hides while searching (it doesn't apply to results).
    expect(
      screen.queryByRole("group", { name: /filter stories by category/i })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(screen.getByText("Story a")).toBeInTheDocument());
    expect(screen.queryByText("Story 42")).not.toBeInTheDocument();
  });
});

describe("App — deep links", () => {
  it("opens a story from a shared #/story/<id> link", async () => {
    window.history.replaceState(null, "", "#/story/42");
    routeFetchMock();
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Story 42" });
    expect(dialog).toBeInTheDocument();
    // Opened via the API, not from the polled grid.
    expect(fetchMock).toHaveBeenCalledWith("/api/clusters/42");
  });

  it("shows a dismissible notice for a dead (pruned) shared link", async () => {
    window.history.replaceState(null, "", "#/story/999");
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/clusters/999")) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve(
        jsonResponse({
          limit: 50,
          offset: 0,
          hasMore: false,
          clusters: [makeCluster("a", "2026-08-15T10:00:00Z")],
        })
      );
    });
    render(<App />);

    const notice = await screen.findByText(/pruned after 14 days/i);
    expect(notice).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss link error/i }));
    await waitFor(() =>
      expect(screen.queryByText(/pruned after 14 days/i)).not.toBeInTheDocument()
    );
  });
});

describe("App — saved bookmarks", () => {
  it("shows the SAVED chip with the bookmark count", async () => {
    routeFetchMock();
    render(<App />);
    await screen.findByText("Story a");

    // No bookmarks yet — chip without a count.
    const chip = screen.getByRole("button", { name: "★ SAVED" });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("filters to saved stories only", async () => {
    // One saved story ("a"); the feed also carries an unsaved one ("b").
    localStorage.setItem("asr.bookmarks", '["a"]');
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          limit: 50,
          offset: 0,
          hasMore: false,
          clusters: [
            makeCluster("a", "2026-08-15T10:00:00Z"),
            makeCluster("b", "2026-08-15T11:00:00Z"),
          ],
        })
      )
    );
    render(<App />);
    await screen.findByText("Story a");
    expect(screen.getByText("Story b")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "★ SAVED 1" }));

    await waitFor(() => {
      expect(screen.queryByText("Story b")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Story a")).toBeInTheDocument();
  });

  it("keeps SAVED out of the URL query string", async () => {
    // Enter with a category filter active, then switch to SAVED.
    window.history.replaceState(null, "", "?category=world");
    routeFetchMock();
    render(<App />);
    await screen.findByText("Story a");
    expect(window.location.search).toBe("?category=world");

    fireEvent.click(screen.getByRole("button", { name: "★ SAVED" }));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("shows the empty hint when nothing is saved", async () => {
    routeFetchMock();
    render(<App />);
    await screen.findByText("Story a");

    fireEvent.click(screen.getByRole("button", { name: "★ SAVED" }));
    expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Tap Save on any story to bookmark it/)
    ).toBeInTheDocument();
  });

  it("says saved stories expired when all bookmarks are pruned", async () => {
    // Saved id "ghost" is not in the feed and 404s on the individual fetch.
    localStorage.setItem("asr.bookmarks", '["ghost"]');
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/clusters/ghost")) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve(
        jsonResponse({
          limit: 50,
          offset: 0,
          hasMore: false,
          clusters: [makeCluster("a", "2026-08-15T10:00:00Z")],
        })
      );
    });
    render(<App />);
    await screen.findByText("Story a");

    fireEvent.click(screen.getByRole("button", { name: "★ SAVED 1" }));
    expect(
      await screen.findByText(/Saved stories have expired/i)
    ).toBeInTheDocument();
  });
});