import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoryModal } from "./StoryModal";
import type { Cluster } from "../types";

const cluster: Cluster = {
  id: "c1",
  keyPhrase: "Test headline story",
  category: "world",
  seenAt: "2026-08-15T00:00:00Z",
  framedAt: "2026-08-15T00:00:00Z",
  framingError: null,
  framing: {
    headlineDeltas: ["Delta one", "Delta two"],
    toneTags: [
      { source: "BBC", tone: "neutral" },
      { source: "CNN", tone: "urgent" },
    ],
    notableOmissions: ["Omitted thing"],
    neutralSummary: "A calm neutral summary of events.",
  },
  articles: [
    {
      source: "BBC",
      title: "BBC headline",
      url: "https://example.com/bbc",
      lede: "BBC lede text",
      publishedAt: "2026-08-15T00:00:00Z",
      imageUrl: "",
    },
    {
      source: "CNN",
      title: "CNN headline",
      url: "https://example.com/cnn",
      lede: "CNN lede text",
      publishedAt: "2026-08-15T00:00:00Z",
      imageUrl: "",
    },
  ],
};

afterEach(() => {
  // RTL auto-cleanup handles unmounting; this keeps the modal's body class
  // and window listeners tidy even if a test fails mid-way.
  document.body.classList.remove("modal-open");
});

describe("StoryModal", () => {
  it("renders headline, deltas, omissions, tones and summary", () => {
    render(<StoryModal cluster={cluster} onClose={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "Test headline story" })
    ).toBeInTheDocument();
    expect(screen.getByText("Delta one")).toBeInTheDocument();
    expect(screen.getByText("Delta two")).toBeInTheDocument();
    expect(screen.getByText("Omitted thing")).toBeInTheDocument();
    expect(screen.getByText(/BBC: neutral/)).toBeInTheDocument();
    expect(screen.getByText(/CNN: urgent/)).toBeInTheDocument();
    expect(
      screen.getByText(/A calm neutral summary of events/)
    ).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<StoryModal cluster={cluster} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last focusable to the first and Shift+Tab back", () => {
    const { container } = render(
      <StoryModal cluster={cluster} onClose={vi.fn()} />
    );
    const panel = container.querySelector(".modal-panel");
    expect(panel).not.toBeNull();

    const focusables = panel!.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    expect(focusables.length).toBeGreaterThanOrEqual(3);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // The close (✕) button heads the panel, so it is the first focusable.
    expect(first).toHaveAttribute("aria-label", "Close story details");

    // Tab on the last focusable wraps to the first (the close button).
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the first focusable wraps to the last.
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("returns focus to the previously focused element on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <StoryModal cluster={cluster} onClose={vi.fn()} />
    );
    expect(document.activeElement).not.toBe(trigger); // panel took focus

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes via the ✕ button", () => {
    const onClose = vi.fn();
    render(<StoryModal cluster={cluster} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close story details" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});