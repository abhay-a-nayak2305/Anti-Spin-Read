import { render, screen } from "@testing-library/react";
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
});