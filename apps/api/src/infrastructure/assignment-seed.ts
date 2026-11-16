import * as argon2 from "argon2";
import { loadConfig } from "../config";
import { createDatabase } from "./database";
import { PrismaTrackerStore } from "./tracker-store";
import { SafeHttp } from "./safe-http";
import { Crawler } from "../application/crawler";
import { CrawlWorker } from "../application/worker";
import { seedRanks } from "./rank-seed";
export async function runSeed() {
  const config = loadConfig();
  if (config.NODE_ENV === "production")
    throw new Error("Demo seed is local-only");
  const db = createDatabase(config.DATABASE_URL);
  const store = new PrismaTrackerStore(db);
  let failed = false;
  try {
    const ownerIds: string[] = [];
    for (const [index, site] of [
      "https://www.semrush.com",
      "https://yoast.com",
    ].entries()) {
      const email = `agency${index + 1}@fieldwork.test`;
      const user = await db.user.upsert({
        where: { email },
        create: {
          email,
          passwordHash: await argon2.hash("Fieldwork-demo-2026!", {
            type: argon2.argon2id,
          }),
        },
        update: {},
      });
      if (!(await argon2.verify(user.passwordHash, "Fieldwork-demo-2026!")))
        throw new Error("Reserved demo email belongs to another local account");
      ownerIds.push(user.id);
      let client: { id: string; name: string; websiteUrl: string } | null =
        await db.client.findUnique({
          where: { ownerId_websiteUrl: { ownerId: user.id, websiteUrl: site } },
        });
      if (!client)
        client = (
          await store.addClient(
            user.id,
            index === 0 ? "Semrush" : "Yoast",
            site,
          )
        ).client;
      if (!client) throw new Error("Client creation failed");
      const job = await store.crawl(user.id, client.id);
      if (!job) throw new Error("Seed client has no crawl job");
      if (["failed", "partial"].includes(job.state) && job.retryable)
        await store.retry(user.id, client.id);
      // Worker may also be running: wait for its durable terminal result rather than claim it twice.
      const worker = new CrawlWorker(store, () => new Crawler(new SafeHttp()));
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const state = await store.crawl(user.id, client.id);
        if (state && ["succeeded", "failed", "partial"].includes(state.state))
          break;
        await worker.runOne(client.id);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const result = await store.crawl(user.id, client.id);
      if (
        !result ||
        result.state !== "succeeded" ||
        result.checkpoints.length !== 15 ||
        result.checkpoints.some((p) => p.state !== "succeeded")
      ) {
        failed = true;
        console.error(
          JSON.stringify({
            site,
            state: result?.state,
            error: result?.error,
            failedUrls: result?.checkpoints.filter(
              (p) => p.state !== "succeeded",
            ),
          }),
        );
      } else
        console.log(
          JSON.stringify({
            site,
            pages: 15,
            status: "live_ingestion_verified",
          }),
        );
    }
    if (!failed) console.log(JSON.stringify(await seedRanks(db, ownerIds)));
    else process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
