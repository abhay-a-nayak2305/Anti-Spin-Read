import { serve } from "@hono/node-server";
import { createApp } from "../src/index.js";
import { MemoryDb } from "../src/db-memory.js";
import { seedFixtures } from "./seed-fixtures.js";

// Seeds a realistic framing dataset into an in-memory Db, then serves the
// real API app over HTTP. Use for UI testing without a Gemini key.
// Usage: PORT=4321 npx tsx scripts/seed-server.ts

const PORT = Number(process.env.PORT || 4000);
const db = new MemoryDb();

await seedFixtures(db);

// One healthy completed run 12 minutes ago so the UI footer's pipeline
// status strip has real data to show ("Healthy · 12m ago").
const RUN_AGE_MS = 12 * 60 * 1000;
await db.recordPipelineRun({
  startedAt: new Date(Date.now() - RUN_AGE_MS),
  finishedAt: new Date(Date.now() - RUN_AGE_MS + 90_000),
  scraped: 732,
  newArticles: 40,
  clusters: 5,
  framed: 5,
  failed: 0,
  skipped: 0,
  error: null,
});

const app = createApp(db);
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[seed-server] on :${info.port}`);
});