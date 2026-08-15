// Launcher: in-memory data + seeded API server on :4321.
// Used by the Playwright browser tests. Exits on SIGTERM.
process.env.PORT = "4321";

await import("./seed-server.js");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
