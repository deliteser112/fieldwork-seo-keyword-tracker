import { loadConfig } from "./config";
import { createDatabase } from "./infrastructure/database";
import { PrismaTrackerStore } from "./infrastructure/tracker-store";
import { SafeHttp } from "./infrastructure/safe-http";
import { Crawler } from "./application/crawler";
import { CrawlWorker } from "./application/worker";
async function main() {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_URL);
  const shutdown = new AbortController();
  process.on("SIGTERM", () => shutdown.abort());
  process.on("SIGINT", () => shutdown.abort());
  try {
    await new CrawlWorker(
      new PrismaTrackerStore(db),
      (signal) => new Crawler(new SafeHttp(), signal),
    ).loop(shutdown.signal);
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  console.error("Worker startup failed");
  process.exitCode = 1;
});
