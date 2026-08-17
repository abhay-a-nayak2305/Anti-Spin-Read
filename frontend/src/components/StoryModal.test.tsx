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

  it("themes text selection with the story's category color", () => {
    const { container } = render(
      <StoryModal cluster={cluster} onClose={vi.fn()} />
    );
    const panel = container.querySelector(".modal-panel");
    expect(panel).not.toBeNull();
    expect((panel as HTMLElement).style.getPropertyValue("--cat")).toBe(
      "var(--color-cat-world)"
    );
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

  it("shows the pending block while framing is being generated", () => {
    render(
      <StoryModal
        cluster={{ ...cluster, framing: null, framedAt: null, framingError: null }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Framing in progress")).toBeInTheDocument();
    // Framing-only sections are hidden, the raw news stays.
    expect(screen.queryByText("How the coverage differs")).not.toBeInTheDocument();
    expect(screen.getByText("The news, outlet by outlet")).toBeInTheDocument();
    expect(screen.getByText("BBC headline")).toBeInTheDocument();
  });

  it("shows the failed block when framing errored (never a false 'pending')", () => {
    render(
      <StoryModal
        cluster={{ ...cluster, framing: null, framedAt: null, framingError: "Framing failed" }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Framing failed")).toBeInTheDocument();
    expect(screen.queryByText("Framing in progress")).not.toBeInTheDocument();
    expect(screen.queryByText("How the coverage differs")).not.toBeInTheDocument();
    expect(screen.getByText("The news, outlet by outlet")).toBeInTheDocument();
  });
});