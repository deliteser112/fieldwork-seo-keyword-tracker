import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/infrastructure/database";
import { PrismaTrackerStore } from "../src/infrastructure/tracker-store";
import { Crawler, extractPage } from "../src/application/crawler";
import { CrawlWorker } from "../src/application/worker";
const config = loadConfig();
if (
  config.NODE_ENV !== "test" ||
  new URL(config.DATABASE_URL).pathname !== "/tracker_test"
)
  throw new Error("Test fixture only");
class CrashCrawler extends Crawler {
  override async discover() {
    return [0, 1, 2].map((ordinal) => ({
      ordinal,
      url: `https://crash-process.example.com/blog/${ordinal}`,
      sourceSitemap: "https://crash-process.example.com/blog.xml",
    }));
  }
  override async analyze(url: string) {
    if (url.endsWith("/1")) await delay(60000);
    return extractPage(
      url,
      "<article><h1>Search visibility</h1><p>Search visibility needs useful content. Search visibility depends on useful content. Useful content improves website visibility and search visibility.</p></article>",
    );
  }
}
const db = createDatabase(config.DATABASE_URL);
void new CrawlWorker(
  new PrismaTrackerStore(db),
  () =>
    new CrashCrawler({
      async get() {
        throw new Error("No fixture network");
      },
    }),
)
  .runOne(process.argv[2])
  .finally(() => db.$disconnect());
