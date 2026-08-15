import { describe, expect, it } from "vitest";
import { faviconUrl, siteHostname, siteInitial } from "./types";

describe("faviconUrl", () => {
  it("points at the site's own /favicon.ico", () => {
    expect(faviconUrl("https://www.example.com/story/123")).toBe(
      "https://www.example.com/favicon.ico"
    );
    expect(faviconUrl("http://example.com/article")).toBe(
      "https://example.com/favicon.ico"
    );
    expect(faviconUrl("https://edition.cnn.com/weather")).toBe(
      "https://edition.cnn.com/favicon.ico"
    );
  });

  it("strips a single trailing dot from fully-qualified domain names", () => {
    expect(faviconUrl("https://example.com./story")).toBe(
      "https://example.com/favicon.ico"
    );
  });

  it("ignores the path, query string and fragment of the site URL", () => {
    expect(faviconUrl("https://example.com/read?utm_source=rss#top")).toBe(
      "https://example.com/favicon.ico"
    );
  });

  it("never references Google's favicon service", () => {
    for (const url of [
      "https://www.bbc.com/news",
      "https://nytimes.com/2026/08/15/world",
      "https://edition.cnn.com/weather",
      "https://example.com./story?utm_source=rss",
    ]) {
      expect(faviconUrl(url)).not.toContain("google.com");
      expect(faviconUrl(url)).not.toContain("s2/favicons");
    }
  });

  it("returns an empty string for a site without a hostname", () => {
    expect(faviconUrl("")).toBe("");
    expect(faviconUrl("not-a-url")).toBe("https://not-a-url/favicon.ico");
  });
});

describe("siteHostname", () => {
  it("extracts the hostname without scheme, path, query or trailing dot", () => {
    expect(siteHostname("https://www.example.com/story")).toBe("www.example.com");
    expect(siteHostname("https://example.com./story")).toBe("example.com");
    expect(siteHostname("https://example.com/?q=1")).toBe("example.com");
  });
});

describe("siteInitial", () => {
  it("returns the uppercased first letter of the hostname", () => {
    expect(siteInitial("https://example.com/story")).toBe("E");
    expect(siteInitial("https://edition.cnn.com/weather")).toBe("E");
  });

  it("skips a www. prefix so monograms stay distinctive", () => {
    expect(siteInitial("https://www.bbc.com/news")).toBe("B");
  });

  it("falls back to a question mark without a hostname", () => {
    expect(siteInitial("")).toBe("?");
  });
});