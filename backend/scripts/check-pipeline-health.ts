import { execFileSync } from "node:child_process";

/**
 * Nightly live pipeline health check (`.github/workflows/nightly.yml`).
 *
 * Queries the remote D1 database directly (via `wrangler d1 execute`) and
 * fails when the pipeline looks unhealthy:
 *   - no run in the last 60 minutes (cron delivery failure / long zombie),
 *   - 3+ consecutive `skipped: 1` runs (the frozen-isolate lock signature
 *     observed Aug 17 2026 — runs skip because a zombie holds the lock),
 *   - framing backlog (framing IS NULL) over 60 clusters.
 *
 * Thresholds are deliberately loose: the point is to alarm on silent
 * degradation, not to flake on a single slow Gemini afternoon.
 *
 * Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env vars (the same
 * secrets deploy.yml uses). One D1 query per night — nothing on the free
 * tier even notices.
 */

const DB_NAME = "anti-spin-read";
const MAX_RUN_AGE_MIN = 60;
const MAX_CONSECUTIVE_SKIPS = 2;
const MAX_BACKLOG = 60;

interface RunRow {
  id: number;
  started_at: number;
  skipped: number;
  error: string | null;
}

function d1Query(statement: string): { results: Record<string, unknown>[] } {
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      "--remote",
      "--json",
      "--command",
      statement,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 120_000 }
  );
  const parsed = JSON.parse(out);
  return parsed[0];
}

function main(): void {
  const runs = d1Query(
    `SELECT id, started_at, skipped, error FROM pipeline_runs ORDER BY id DESC LIMIT 8;`
  ).results as unknown as RunRow[];
  const backlogRow = d1Query(
    `SELECT COUNT(*) AS n FROM clusters WHERE framing IS NULL;`
  ).results[0];
  const backlog = Number(backlogRow?.n ?? -1);

  if (runs.length === 0) {
    console.error("FAIL: pipeline_runs is empty — the pipeline never ran");
    process.exit(1);
  }

  const newest = runs[0];
  const newestAgeMin = (Date.now() - Number(newest.started_at)) / 60_000;
  console.log(
    `pipeline health: newest run #${newest.id} ${newestAgeMin.toFixed(1)} min old (skipped=${newest.skipped}), backlog=${backlog}`
  );

  let failures: string[] = [];

  if (newestAgeMin > MAX_RUN_AGE_MIN) {
    failures.push(
      `no run for ${newestAgeMin.toFixed(0)} min (max ${MAX_RUN_AGE_MIN}) — cron delivery may have failed or a zombie holds the lock`
    );
  }

  let consecutive = 0;
  for (const r of runs) {
    if (r.skipped === 1) consecutive++;
    else break;
  }
  if (consecutive > MAX_CONSECUTIVE_SKIPS) {
    failures.push(
      `${consecutive} consecutive skipped runs (max ${MAX_CONSECUTIVE_SKIPS}) — pipeline lock held by a stuck run; lease steal should clear it, but this needs eyes`
    );
  }

  if (backlog < 0) {
    failures.push("backlog query returned no rows");
  } else if (backlog > MAX_BACKLOG) {
    failures.push(`framing backlog ${backlog} > ${MAX_BACKLOG} — framing cron may be stuck`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error("PIPELINE HEALTH CHECK FAILED");
    process.exit(1);
  }
  console.log("PASS: pipeline is healthy");
}

main();
