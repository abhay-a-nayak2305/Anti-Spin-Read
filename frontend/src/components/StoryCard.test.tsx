import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StoryCard } from "./StoryCard";
import type { Cluster } from "../types";

const cluster: Cluster = {
  id: "c1",
  keyPhrase: "Test story headline",
  category: "world",
  seenAt: "2026-08-15T00:00:00Z",
  framedAt: null,
  framingError: null,
  framing: null,
  articles: [],
};

describe("StoryCard", () => {
  it("shows the NEW stamp when the story is new since the watermark", () => {
    render(<StoryCard cluster={cluster} onOpen={vi.fn()} isNew />);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("omits the NEW stamp when the story is not new", () => {
    render(<StoryCard cluster={cluster} onOpen={vi.fn()} isNew={false} />);
    expect(screen.queryByText("New")).not.toBeInTheDocument();
  });

  it("omits the NEW stamp by default", () => {
    render(<StoryCard cluster={cluster} onOpen={vi.fn()} />);
    expect(screen.queryByText("New")).not.toBeInTheDocument();
  });

  it("themes text selection with the story's category color", () => {
    const { container } = render(<StoryCard cluster={cluster} onOpen={vi.fn()} />);
    const card = container.querySelector(".story-card");
    expect(card).not.toBeNull();
    expect((card as HTMLElement).style.getPropertyValue("--cat")).toBe(
      "var(--color-cat-world)"
    );
  });

  it("always renders a hero image via the fallback chain (no NO IMAGE box)", () => {
    const { container } = render(
      <StoryCard
        cluster={{
          ...cluster,
          articles: [
            {
              source: "BBC",
              title: "No og:image story",
              url: "https://www.bbc.co.uk/news/x",
              lede: "lede",
              publishedAt: "2026-08-15T00:00:00Z",
              imageUrl: "",
            },
          ],
        }}
        onOpen={vi.fn()}
      />
    );
    // The favicon is the first fallback candidate: /favicon.ico on the site host.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("bbc.co.uk/favicon.ico");
    expect(screen.queryByText("NO IMAGE")).not.toBeInTheDocument();
  });

  it("outlines OTHER cards in white (visible on the black page)", () => {
    const { container } = render(
      <StoryCard cluster={{ ...cluster, category: "other" }} onOpen={vi.fn()} />
    );
    const card = container.querySelector(".story-card");
    expect(card!.className).toContain("border-paper");
    expect(card!.className).toContain("shadow-[8px_8px_0_var(--color-paper)]");
    expect(card!.className).not.toContain("border-ink");
  });

  it("shows the Framing… pending chip while the report is being generated", () => {
    render(
      <StoryCard
        cluster={{ ...cluster, framing: null, framingError: null }}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText("Framing…")).toBeInTheDocument();
  });

  it("omits the pending chip once framing exists", () => {
    render(
      <StoryCard
        cluster={{
          ...cluster,
          framing: {
            headlineDeltas: [],
            toneTags: [],
            notableOmissions: [],
            neutralSummary: "Summary.",
          },
          framingError: null,
        }}
        onOpen={vi.fn()}
      />
    );
    expect(screen.queryByText("Framing…")).not.toBeInTheDocument();
  });

  it("omits the pending chip when framing failed (error state, not pending)", () => {
    render(
      <StoryCard
        cluster={{ ...cluster, framing: null, framingError: "Framing failed" }}
        onOpen={vi.fn()}
      />
    );
    expect(screen.queryByText("Framing…")).not.toBeInTheDocument();
  });

  it("shows a labeled Save button reflecting the saved prop", () => {
    render(
      <StoryCard
        cluster={cluster}
        onOpen={vi.fn()}
        saved={false}
        onToggleSave={vi.fn()}
      />
    );
    const save = screen.getByRole("button", { name: "Save story" });
    expect(save).toHaveAttribute("aria-pressed", "false");
    expect(save).toHaveAttribute("title", "Save story");
    expect(save.textContent).toContain("Save");

    render(
      <StoryCard
        cluster={cluster}
        onOpen={vi.fn()}
        saved
        onToggleSave={vi.fn()}
      />
    );
    const unsave = screen.getByRole("button", { name: "Unsave story" });
    expect(unsave).toHaveAttribute("aria-pressed", "true");
    expect(unsave.textContent).toContain("Saved");
  });

  it("toggles via onToggleSave with the cluster when Save is clicked", () => {
    const onToggleSave = vi.fn();
    render(
      <StoryCard
        cluster={cluster}
        onOpen={vi.fn()}
        saved={false}
        onToggleSave={onToggleSave}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Save story" }));
    expect(onToggleSave).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledWith(cluster);
  });

  it("omits the Save button entirely when no save handler is wired", () => {
    render(<StoryCard cluster={cluster} onOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /save story/i })).not.toBeInTheDocument();
  });
});