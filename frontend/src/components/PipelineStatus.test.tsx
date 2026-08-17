import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineStatus } from "./PipelineStatus";
import type { PipelineRun, RunsResponse } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/** A finished run whose age renders as "12m ago" regardless of wall-clock. */
function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 1,
    startedAt: new Date(Date.now() - 13 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    scraped: 10,
    newArticles: 3,
    clusters: 2,
    framed: 2,
    failed: 0,
    skipped: 0,
    error: null,
    ...overrides,
  };
}

function makeRuns(runs: PipelineRun[], backlog = 0): RunsResponse {
  return { runs, backlog };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PipelineStatus", () => {
  it("renders Healthy with the run age and the unframed backlog", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(makeRuns([makeRun()], 3))
    );

    render(<PipelineStatus />);

    expect(fetchMock).toHaveBeenCalledWith("/api/runs?limit=3");
    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("12m ago")).toBeInTheDocument();
    expect(screen.getByText("3 unframed")).toBeInTheDocument();
  });

  it("hides the backlog line when there is nothing unframed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeRuns([makeRun()], 0)));

    render(<PipelineStatus />);

    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText(/unframed/)).not.toBeInTheDocument();
  });

  it("renders the alarm stamp for a failed run", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(makeRuns([makeRun({ error: "Gemini quota exceeded" })]))
    );

    render(<PipelineStatus />);

    expect(await screen.findByText("Pipeline error")).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });

  it("renders the pending stamp for a lock-skipped run", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeRuns([makeRun({ skipped: 1 })])));

    render(<PipelineStatus />);

    expect(await screen.findByText("Skipped")).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
  });

  it("uses the newest run when several are returned", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeRuns([
          makeRun({ id: 2, error: "boom" }),
          makeRun({ id: 1, finishedAt: new Date(Date.now() - 120 * 60_000).toISOString() }),
        ])
      )
    );

    render(<PipelineStatus />);

    // The newest run (id 2) wins — its error drives the stamp.
    expect(await screen.findByText("Pipeline error")).toBeInTheDocument();
    expect(screen.queryByText("2h ago")).not.toBeInTheDocument();
  });

  it("renders nothing while the first fetch is still in flight", async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((res) => (resolveFetch = res))
    );

    const { container } = render(<PipelineStatus />);
    expect(container.innerHTML).toBe("");

    await act(async () => {
      resolveFetch(jsonResponse(makeRuns([makeRun()])));
    });
    expect(container.innerHTML).not.toBe("");
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders nothing at all when the first fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { container } = render(<PipelineStatus />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("tolerates a malformed response body without throwing", async () => {
    // App tests' generic mocks return cluster shapes for every URL; the
    // footer must not crash on them.
    fetchMock.mockResolvedValue(
      jsonResponse({ limit: 50, offset: 0, hasMore: false, clusters: [] })
    );
    const { container } = render(<PipelineStatus />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("polls every 5 minutes and stops after unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(makeRuns([makeRun()])));

    const { unmount } = render(<PipelineStatus />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    vi.advanceTimersByTime(5 * 60_000);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2); // cleaned up — no more polls
  });
});