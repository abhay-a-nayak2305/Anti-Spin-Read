import { scrapeAll } from "../src/scraper.js";
import { sources } from "../src/config.js";

/**
 * Nightly feed health check (`.github/workflows/nightly.yml`).
 *
 * Scrapes every outlet live and fails when too few respond. A silent feed
 * URL change or an IP block would otherwise degrade the product with no
 * test noticing — offline eval gates can't catch that, only a live fetch
 * can. No Gemini key needed; this is pure RSS fetching.
 */
const MIN_OUTLETS = Math.max(10, Math.floor(sources.length * 0.6));

async function main() {
  const t0 = Date.now();
  const articles = await scrapeAll(24);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const responding = new Set(articles.map((a) => a.source));
  const missing = sources
    .map((s) => s.label)
    .filter((label) => !responding.has(label))
    .sort();

  console.log(
    `feed check: ${responding.size}/${sources.length} outlets, ${articles.length} articles in ${elapsed}s`
  );
  for (const label of [...responding].sort()) console.log(`  ok: ${label}`);
  for (const label of missing) console.log(`  MISSING: ${label}`);

  if (responding.size < MIN_OUTLETS) {
    console.error(
      `FAIL: only ${responding.size} outlets responded (min ${MIN_OUTLETS}) — feeds may have changed URLs or been IP-blocked`
    );
    process.exit(1);
  }
  console.log(
    `PASS: ${responding.size}/${sources.length} outlets responding (min ${MIN_OUTLETS})`
  );
}

main().catch((err) => {
  console.error("feed check crashed:", err);
  process.exit(1);
});