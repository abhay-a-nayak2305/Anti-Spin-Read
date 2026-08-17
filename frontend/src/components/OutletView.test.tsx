import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutletView } from "./OutletView";
import type { Cluster, OutletResponse } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function makeCluster(id: string, keyPhrase: string, seenAt: string): Cluster {
  return {
    id,
    keyPhrase,
    category: "world",
    seenAt,
    framedAt: "2026-08-15T12:00:00Z",
    framingError: null,
    framing: {
      headlineDeltas: ["A delta"],
      toneTags: [],
      notableOmissions: [],
      neutralSummary: "A summary.",
    },
    articles: [],
  };
}

/** Full OutletResponse fixture matching the live API contract. */
function makeOutletResponse(clusters: Cluster[] = []): OutletResponse {
  return {
    outlet: "BBC",
    hasMore: false,
    stat: {
      source: "BBC",
      frames: 3,
      spun: 1,
      spinRatio: 1 / 3,
      tones: { neutral: 2, urgent: 1 },
    },
    clusters,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OutletView", () => {
  it("fetches the outlet page and renders name, stat line and cluster cards", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeOutletResponse([
          makeCluster("o1", "BBC story one", "2026-08-15T10:00:00Z"),
          makeCluster("o2", "BBC story two", "2026-08-15T11:00:00Z"),
        ])
      )
    );

    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/outlets/BBC?limit=50");

    const heading = await screen.findByRole("heading", { name: "BBC" });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByText("3 framed stories · 1 spun (33%)")
    ).toBeInTheDocument();
    // Tone chips, highest count first, capped at 4.
    expect(screen.getByText("neutral ×2")).toBeInTheDocument();
    expect(screen.getByText("urgent ×1")).toBeInTheDocument();
    expect(screen.getByText("BBC story one")).toBeInTheDocument();
    expect(screen.getByText("BBC story two")).toBeInTheDocument();
  });

  it("re-encodes the outlet name for the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeOutletResponse([])));
    render(
      <OutletView
        name="The Times"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/outlets/The%20Times?limit=50")
    );
  });

  it("wires the saved/heart props through to story cards", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeOutletResponse([
          makeCluster("o1", "Saved story", "2026-08-15T10:00:00Z"),
          makeCluster("o2", "Unsaved story", "2026-08-15T11:00:00Z"),
        ])
      )
    );
    const isSaved = (id: string) => id === "o1";
    const onToggleSave = vi.fn();

    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={isSaved}
        onToggleSave={onToggleSave}
      />
    );

    await screen.findByText("Saved story");
    expect(screen.getByRole("button", { name: "Unsave story" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Save story" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    fireEvent.click(screen.getByRole("button", { name: "Save story" }));
    expect(onToggleSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o2" })
    );
  });

  it("shows the empty state with the toneTag mismatch hint for zero clusters", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeOutletResponse([])));
    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    expect(await screen.findByText("No stories from BBC yet")).toBeInTheDocument();
    expect(screen.getByText(/Gemini tone labels/i)).toBeInTheDocument();
  });

  it("notes the 50-cap when more clusters exist", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...makeOutletResponse([makeCluster("o1", "S", "2026-08-15T10:00:00Z")]), hasMore: true })
    );
    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    expect(
      await screen.findByText(/Showing the 50 most recent — load more coming soon/)
    ).toBeInTheDocument();
  });

  it("renders a compact error slab without crashing when the fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    expect(await screen.findByText("Couldn't load BBC")).toBeInTheDocument();
    expect(screen.getByText("Connection error")).toBeInTheDocument();
  });

  it("calls onBack from the back button", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeOutletResponse([])));
    const onBack = vi.fn();
    render(
      <OutletView
        name="BBC"
        onOpen={vi.fn()}
        onBack={onBack}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "← Back to radar" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens a story via onOpen from a card", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeOutletResponse([makeCluster("o1", "Clickable story", "2026-08-15T10:00:00Z")])
      )
    );
    const onOpen = vi.fn();
    render(
      <OutletView
        name="BBC"
        onOpen={onOpen}
        onBack={vi.fn()}
        isSaved={() => false}
        onToggleSave={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByText("Clickable story"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "o1" }));
  });
});