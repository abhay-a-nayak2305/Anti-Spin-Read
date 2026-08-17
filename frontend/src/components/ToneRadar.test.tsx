import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToneRadar } from "./ToneRadar";
import type { ToneRadarResponse } from "../types";

const fetchMock = vi.fn();

function jsonResponse(body: ToneRadarResponse) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToneRadar", () => {
  it("renders outlet bars with spin shares and tone counts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        computedAt: "2026-08-17T10:00:00Z",
        outlets: [
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
        ],
      })
    );

    render(<ToneRadar />);

    expect(fetchMock).toHaveBeenCalledWith("/api/tone-radar");
    expect(await screen.findByText("BBC")).toBeInTheDocument();
    expect(screen.getByText("CNN")).toBeInTheDocument();
    expect(screen.getByLabelText("BBC: 2 of 3 frames spun")).toBeInTheDocument();
    expect(screen.getByText(/2\/3/)).toBeInTheDocument();
    expect(screen.getByText("celebratory ×2")).toBeInTheDocument();
    expect(screen.getByText("analytical ×1")).toBeInTheDocument();
  });

  it("renders nothing (not an error) when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { container } = render(<ToneRadar />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});