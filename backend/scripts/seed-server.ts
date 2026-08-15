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

const app = createApp(db);
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[seed-server] on :${info.port}`);
});