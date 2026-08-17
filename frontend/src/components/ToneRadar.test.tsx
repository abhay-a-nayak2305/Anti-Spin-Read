import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToneRadar } from "./ToneRadar";
import type { ToneRadarResponse } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: ToneRadarResponse) {
  return { ok: true, json: async () => body };
}

/** Radar fixture: no category echo unless one is supplied. */
function radarBody(
  category: string | null = null,
  outlets: ToneRadarResponse["outlets"] = [
    {
      source: "BBC",
      frames: 3,
      spun: 2,
      spinRatio: 2 / 3,
      tones: { neutral: 1, celebratory: 2 },
    },
    {
      source: "CNN",
      frames: 1,
      spun: 0,
      spinRatio: 0,
      tones: { analytical: 1 },
    },
  ]
): ToneRadarResponse {
  return { computedAt: "2026-08-17T10:00:00Z", category, outlets };
}

beforeEach(() => {
  fetchMock.mockReset();
  window.location.hash = "";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToneRadar", () => {
  it("renders outlet bars with spin shares and tone counts", async () => {
    fetchMock.mockResolvedValue(jsonResponse(radarBody()));

    render(<ToneRadar />);

    expect(fetchMock).toHaveBeenCalledWith("/api/tone-radar");
    expect(await screen.findByText("BBC")).toBeInTheDocument();
    expect(screen.getByText("CNN")).toBeInTheDocument();
    expect(screen.getByLabelText("BBC: 2 of 3 frames spun")).toBeInTheDocument();
    expect(screen.getByText(/2\/3/)).toBeInTheDocument();
    expect(screen.getByText("celebratory ×2")).toBeInTheDocument();
    expect(screen.getByText("analytical ×1")).toBeInTheDocument();
  });

  it("renders the category chip row with ALL plus every category", async () => {
    fetchMock.mockResolvedValue(jsonResponse(radarBody()));

    render(<ToneRadar />);
    await screen.findByText("BBC");

    const group = screen.getByRole("group", {
      name: /filter tone radar by category/i,
    });
    expect(group).toBeInTheDocument();
    expect(group.querySelectorAll("button")).toHaveLength(9); // ALL + 8
    // ALL is the initial selection.
    expect(screen.getByRole("button", { name: "ALL" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Politics" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("refetches with ?category= when a chip is clicked and back to all on ALL", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("category=tech")) {
        return Promise.resolve(
          jsonResponse(radarBody("tech", [
            { source: "The Verge", frames: 2, spun: 2, spinRatio: 1, tones: { celebratory: 2 } },
          ]))
        );
      }
      return Promise.resolve(jsonResponse(radarBody()));
    });

    render(<ToneRadar />);
    await screen.findByText("BBC");

    fireEvent.click(screen.getByRole("button", { name: "Tech" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/tone-radar?category=tech")
    );
    // The response's category echo drives the header suffix and chip state.
    expect(
      await screen.findByText(/last 200 framed stories · updates every run · Tech/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tech" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("The Verge")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "ALL" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith("/api/tone-radar")
    );
    expect(await screen.findByText("BBC")).toBeInTheDocument();
    expect(screen.queryByText("The Verge")).not.toBeInTheDocument();
  });

  it("navigates to the outlet route when an outlet name is clicked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(radarBody()));

    render(<ToneRadar />);
    const outletButton = await screen.findByRole("button", { name: "BBC" });
    expect(outletButton).toBeInTheDocument();

    fireEvent.click(outletButton);
    expect(window.location.hash).toBe("#/outlet/BBC");
  });

  it("renders nothing (not an error) when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { container } = render(<ToneRadar />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});