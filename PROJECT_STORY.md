# Project story

## What inspired it

I kept noticing the same event reported with wildly different headlines, tones, and omissions across outlets — one paper calls a protest a "riot," another calls it a "demonstration"; one leads with the cause, another with the property damage. The framing shapes what you believe happened, often before you read a single sentence. I wanted a tool that puts the spins side by side so you can see the differences yourself, without an algorithmic feed deciding what you see.

## What I learned

**On the backend:**
- Cloudflare Workers are a genuinely fun constraint: one isolate, 50 subrequests per invocation, no filesystem, no child processes. Every design decision has to fit inside that box.
- D1 (SQLite on Cloudflare) is surprisingly capable for a free-tier database. The schema is small, migrations are just SQL files, and the single-row lock pattern (`INSERT OR IGNORE` + 15-min lease) is elegant for serializing cron runs.
- The Gemini API's `responseSchema` + strict JSON mode turns a "creative" LLM into a deterministic extractor — the same input always produces parseable, structured output.
- Jaccard similarity with a rare-token boost is a simple but effective clustering heuristic for short news text. The math:

  $$
  \text{score}(A, B) = \frac{|A \cap B|}{|A \cup B|} \times \left(1 + 2 \cdot \frac{|\text{rare}(A) \cap \text{rare}(B)|}{|\text{rare}(A) \cup \text{rare}(B)|}\right)
  $$

  where rare tokens are those appearing in fewer than 5 articles in the current window. The boost ensures that two stories sharing an unusual word ("Hamas," "Strait of Hormuz") rank higher than two generic crime stories sharing "police."

- **SSRF is hard.** Every URL from feed data (article links, `og:image` URLs) passes through `isSafeHttpUrl`, which rejects private IPs in every encoding (dotted, decimal, hex, octal, short form), IPv6 literals, and reserved suffixes. Adding bounded redirect-following to `fetchOgImage` required re-checking every hop *before* fetching it — a chain that bounces toward `169.254.169.254` must be dropped at the hop, not after.

**On the frontend:**
- A 16:9 hero image with an explicit aspect-ratio wrapper and intrinsic `width`/`height` attributes is the cheapest way to eliminate CLS.
- Grayscale + high contrast on article images is a cheap trick to make a heterogeneous image set feel cohesive without a design system.
- CSS custom properties (`--cat`) set per-card from JavaScript let a single stylesheet drive 8 category color schemes without runtime class bloat.

## How it was built

The pipeline runs on a schedule (every 15 minutes) and on demand via `POST /api/cron`:

1. **Scrape** — fetches Google News RSS for 18 outlets (with direct-feed fallback where available). Each item is deduplicated by a hash of the normalized title, then cleaned (outlet suffixes stripped, HTML entities decoded).
2. **Cluster** — new articles are pooled with recent unclustered articles (48 h window), then grouped by Jaccard + rare-token boost. Clusters must span 2+ outlets; same-outlet duplicates are discarded.
3. **Enrich** — each new-cluster article without an image gets its `og:image` fetched from the publisher page. Fetches follow up to 2 redirect hops, re-check SSRF on every hop, and decode HTML entities in the returned URL. Every attempt is stamped with a timestamp so blocked publishers can't hog the subrequest budget.
4. **Frame** — up to 3 concurrent Gemini calls per cluster with a constrained JSON schema. Output is validated by `normalizeFraming` at rest; the same rules that accept model output gate what's persisted.
5. **Maintain** — clusters older than 14 days are purged; orphaned articles are removed; the run log is trimmed to 90 days.
6. **Record** — every run (success or failure) is appended to `pipeline_runs` for the nightly health check.

The API (Hono) and the React SPA are built into the same Worker. `wrangler deploy` ships DB schema, API, and assets together. No CDN, no separate origin.

## Challenges

**The 50-subrequest budget.** A normal run needs ~18 RSS fetches + 8 enrichment + 9 framing = 35. But a day when every direct feed redirects and falls back to Google News pushes the RSS cost to 36, and enrichment with redirect-following can cost 3× per article. The first version treated every redirect as "no image," which made Google-News links and redirecting publishers permanently unenrichable. The fix — bounded redirect-following with per-hop SSRF checks — added real coverage without breaking the budget, because the retry gate keeps blocked publishers out of the queue.

**Favicons as images.** The first attempt at a fallback chain used the site's `/favicon.ico` as the hero when `og:image` was missing. A 16×16 logo stretched across a 16:9 box reads as a broken or wrong image — it showed up on roughly a third of the live cards. The fix was to skip the favicon for heroes and use the letter-monogram placeholder instead (the favicon stays for 40×40 article thumbnails in the modal, where it's legible).

**Entity-encoded URLs.** Several outlets (CNBC, Al Jazeera) encode `&` as `&amp;` inside `<meta property="og:image" content="…">` attributes. The Workers HTMLRewriter's `getAttribute` returns raw text — it does not decode HTML entities. A stored `&amp;` in a query string corrupts the parameters (`?w=1920&amp;h=1080` becomes `?w=1920&amp;h=1080` literally). The fix was a small `decodeEntities` helper, shared between the scraper and the og:image path.

**Free-tier reliability.** The Worker's 15-minute cron is the only scheduler. No Redis, no message queue, no second Worker. If a run hangs, the D1 lock lease (15 min) is the only backstop. Adding a 12-minute watchdog that records which stage it was stuck in ("stuck in stage enrich") turned a silent zombie into a skipped slot the next cron could recover from.

**Testing against real infrastructure.** The D1 test harness uses real SQLite with real migrations applied in order — the same SQL that runs in production. The Playwright smoke test runs against a seeded in-memory API (no network, no keys) and exercises the full SPA (filters, modals, save/bookmark, responsive layout) in under 10 seconds.
