import { randomUUID } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import * as argon2 from "argon2";
import { loadConfig } from "../config";
import { createDatabase } from "./database";
import { createApp } from "../app";
export async function runBenchmark() {
  const config = loadConfig();
  if (config.NODE_ENV === "production") throw new Error("Local benchmark only");
  const db = createDatabase(config.DATABASE_URL);
  const owners: string[] = [];
  const app = await createApp({
    ...config,
    APP_ORIGIN: "http://benchmark.invalid",
    TRUST_PROXY_HOPS: 0,
  });
  const results: {
    scenario: string;
    requests: number;
    errors: number;
    p95Ms: number;
    durationSeconds: number;
    pass: boolean;
  }[] = [];
  try {
    if ((await db.rankSnapshot.count()) < 50000)
      throw new Error(
        "Run the successful live seed first (>=50k snapshots required)",
      );
    const source = await db.page.findMany({
      where: { client: { owner: { email: "agency1@fieldwork.test" } } },
      include: { keywords: { include: { snapshots: true } } },
      take: 15,
      orderBy: { id: "asc" },
    });
    if (source.length !== 15)
      throw new Error("Required live-seeded dataset unavailable");
    const password = "benchmark-" + randomUUID();
    const passwordHash = await argon2.hash(password);
    const actors: {
      email: string;
      cookie: string;
      pageId: string;
      search: string;
    }[] = [];
    for (let i = 0; i < 5; i++) {
      const user = await db.user.create({
        data: { email: `benchmark-${randomUUID()}@example.test`, passwordHash },
      });
      owners.push(user.id);
      const client = await db.client.create({
        data: {
          ownerId: user.id,
          name: "Temporary benchmark",
          websiteUrl: "https://benchmark.example.com",
        },
      });
      let pageId = "";
      let search = "";
      for (const original of source) {
        const page = await db.page.create({
          data: {
            clientId: client.id,
            url: original.url,
            title: original.title,
            ruleVersion: original.ruleVersion,
          },
        });
        if (!pageId) pageId = page.id;
        for (const k of original.keywords) {
          const keyword = await db.keyword.create({
            data: {
              pageId: page.id,
              term: k.term,
              score: k.score,
              evidence: k.evidence,
            },
          });
          if (!search) search = k.term;
          await db.rankSnapshot.createMany({
            data: k.snapshots.map((s) => ({
              keywordId: keyword.id,
              capturedAt: s.capturedAt,
              position: s.position,
            })),
          });
        }
      }
      actors.push({ email: user.email, cookie: "", pageId, search });
    }
    await db.$executeRawUnsafe('ANALYZE "Page"');
    await db.$executeRawUnsafe('ANALYZE "Keyword"');
    await db.$executeRawUnsafe('ANALYZE "RankSnapshot"');
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    for (const actor of actors) {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          origin: "http://benchmark.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: actor.email, password }),
      });
      if (!response.ok) throw new Error("Benchmark authentication failed");
      actor.cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      await response.arrayBuffer();
    }
    const scenarios = [
      { name: "pages-list", path: () => "/api/pages" },
      { name: "url-search", path: () => "/api/pages?search=blog" },
      {
        name: "keyword-search",
        path: (a: (typeof actors)[number]) =>
          `/api/pages?search=${encodeURIComponent(a.search)}`,
      },
      {
        name: "90-day-history",
        path: (a: (typeof actors)[number]) =>
          `/api/pages/${a.pageId}/history?from=2026-08-18&to=2026-11-15`,
      },
    ];
    for (const scenario of scenarios) {
      const warmup = performance.now() + 30000;
      async function request(actor: (typeof actors)[number]) {
        const response = await fetch(base + scenario.path(actor), {
          headers: { cookie: actor.cookie },
          signal: AbortSignal.timeout(10000),
        });
        await response.arrayBuffer();
        return response.ok;
      }
      await Promise.all(
        actors.map(async (actor) => {
          while (performance.now() < warmup) await request(actor);
        }),
      );
      const times: number[] = [];
      let errors = 0;
      const start = performance.now();
      await Promise.all(
        actors.map(async (actor) => {
          let count = 0;
          while (performance.now() - start < 60000 || count < 200) {
            const t = performance.now();
            try {
              if (!(await request(actor))) errors++;
            } catch {
              errors++;
            }
            times.push(performance.now() - t);
            count++;
          }
        }),
      );
      times.sort((a, b) => a - b);
      const p95Ms = times[Math.ceil(times.length * 0.95) - 1]!;
      const result = {
        scenario: scenario.name,
        requests: times.length,
        errors,
        p95Ms,
        durationSeconds: (performance.now() - start) / 1000,
        pass: p95Ms < 500 && errors === 0,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const key = await db.keyword.findFirstOrThrow({
      where: { pageId: actors[0]!.pageId },
    });
    const plans = {
      latest:
        await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT position FROM "RankSnapshot" WHERE "keywordId"=${key.id}::uuid ORDER BY "capturedAt" DESC LIMIT 1`,
      history:
        await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "capturedAt",position FROM "RankSnapshot" WHERE "keywordId"=${key.id}::uuid AND "capturedAt">='2026-08-18T04:00:00Z' AND "capturedAt"<'2026-11-16T05:00:00Z' ORDER BY "capturedAt"`,
      pages:
        await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT p.id FROM "Page" p JOIN "Client" c ON c.id=p."clientId" WHERE c."ownerId"=${owners[0]}::uuid ORDER BY p.id LIMIT 20`,
      search:
        await db.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT p.id FROM "Page" p JOIN "Client" c ON c.id=p."clientId" WHERE c."ownerId"=${owners[0]}::uuid AND (p.url ILIKE '%blog%' OR EXISTS (SELECT 1 FROM "Keyword" k WHERE k."pageId"=p.id AND k.term ILIKE '%search%')) ORDER BY p.id LIMIT 20`,
    };
    await mkdir("docs", { recursive: true });
    await writeFile(
      "docs/benchmark-results.json",
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          hardware: {
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            ramBytes: totalmem(),
            platform: platform(),
            release: release(),
          },
          node: process.version,
          database: await db.$queryRaw`SELECT version()`,
          snapshots: await db.rankSnapshot.count(),
          users: 5,
          warmupSeconds: 30,
          results,
          plans,
        },
        null,
        2,
      ) + "\n",
    );
    if (results.some((r) => !r.pass)) process.exitCode = 1;
  } finally {
    await app.close();
    await db.user.deleteMany({ where: { id: { in: owners } } });
    await db.$disconnect();
  }
}
