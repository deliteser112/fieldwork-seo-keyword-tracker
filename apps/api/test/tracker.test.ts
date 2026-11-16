import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { loadConfig } from "../src/config";
import { createApp } from "../src/app";
import { createDatabase } from "../src/infrastructure/database";
import { PrismaTrackerStore } from "../src/infrastructure/tracker-store";
import { seedRanks } from "../src/infrastructure/rank-seed";
import { torontoRange } from "../src/application/tracker";
import { Crawler, extractPage } from "../src/application/crawler";
import { CrawlWorker } from "../src/application/worker";
import { CrawlError } from "../src/application/crawl-contract";
const config = loadConfig();
if (
  new URL(config.DATABASE_URL).pathname !== "/tracker_test" ||
  config.NODE_ENV !== "test"
)
  throw new Error("Dedicated test database required");
const db = createDatabase(config.DATABASE_URL);
const store = new PrismaTrackerStore(db);
let owner = "";
let other = "";
let cookie = "";
let csrf = "";
let app: Awaited<ReturnType<typeof createApp>>;
const html =
  "<title>Search optimization guide</title><article><h1>Search optimization</h1><p>Search optimization improves website visibility. Search optimization means useful content. Website visibility needs useful content and clear search optimization.</p></article>";
const analysis = (url: string) => extractPage(url, html);
before(async () => {
  const passwordHash = await argon2.hash("test-password");
  owner = (
    await db.user.create({
      data: { email: `tracker-${randomUUID()}@example.test`, passwordHash },
    })
  ).id;
  other = (
    await db.user.create({
      data: { email: `other-${randomUUID()}@example.test`, passwordHash },
    })
  ).id;
  app = await createApp(config);
  const user = await db.user.findUniqueOrThrow({ where: { id: owner } });
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: config.APP_ORIGIN },
      payload: { email: user.email, password: "test-password" },
    });
  assert.equal(res.statusCode, 200);
  cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  csrf = res.json().csrfToken;
});
after(async () => {
  await app?.close();
  await db.user.deleteMany({
    where: { id: { in: [owner, other].filter(Boolean) } },
  });
  await db.$disconnect();
});
function server() {
  return app.getHttpAdapter().getInstance();
}
const headers = () => ({
  cookie,
  origin: config.APP_ORIGIN,
  "x-csrf-token": csrf,
});
test("Toronto inclusive calendar dates handle both DST transitions and invalid inputs", () => {
  const spring = torontoRange("2026-03-08", "2026-03-08");
  assert.equal((+spring.end - +spring.start) / 3600000, 23);
  const autumn = torontoRange("2026-11-01", "2026-11-01");
  assert.equal((+autumn.end - +autumn.start) / 3600000, 25);
  assert.throws(() => torontoRange("2026-02-30", "2026-03-01"));
  assert.throws(() => torontoRange("2026-11-02", "2026-11-01"));
});
test("concurrent client creation is unique and client/job insertion is atomic", async () => {
  const url = `https://race-${randomUUID()}.example.com`;
  const results = await Promise.allSettled([
    store.addClient(owner, "Race", url),
    store.addClient(owner, "Race", url),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const client = await db.client.findUniqueOrThrow({
    where: { ownerId_websiteUrl: { ownerId: owner, websiteUrl: url } },
    include: { crawl: true },
  });
  assert.ok(client.crawl);
  await db.client.delete({ where: { id: client.id } });
  await assert.rejects(
    store.addClient(randomUUID(), "Missing owner", "https://example.com"),
  );
  assert.equal(await db.client.count({ where: { name: "Missing owner" } }), 0);
});
test("HTTP mutation validation, CSRF, ownership and duplicate errors are safe", async () => {
  const client = await store.addClient(
    other,
    "Private",
    "https://private.example.com",
  );
  const page = await db.page.create({
    data: {
      clientId: client.client.id,
      url: "https://private.example.com/blog/a",
      title: "Private",
      ruleVersion: "test",
    },
  });
  for (const url of [
    `/api/clients/${client.client.id}/crawl`,
    `/api/pages/${page.id}`,
    `/api/pages/${page.id}/history?from=2026-01-01&to=2026-01-02`,
    `/api/pages?clientId=${client.client.id}`,
  ]) {
    const denied = await server().inject({
      method: "GET",
      url,
      headers: headers(),
    });
    assert.equal(denied.statusCode, 404, url);
    assert.equal(denied.json().error, "NOT_FOUND");
  }
  assert.equal(
    (
      await server().inject({
        method: "POST",
        url: `/api/clients/${client.client.id}/crawl/retry`,
        headers: headers(),
        payload: {},
      })
    ).statusCode,
    404,
  );
  const bad = await server().inject({
    method: "POST",
    url: "/api/clients",
    headers: { ...headers(), "x-csrf-token": "bad" },
    payload: { name: "x", websiteUrl: "https://example.com" },
  });
  assert.equal(bad.statusCode, 403);
  for (const websiteUrl of [
    "file:///etc/passwd",
    "http://127.0.0.1",
    "https://user:pw@example.com",
    "https://example.com:8000",
  ])
    assert.equal(
      (
        await server().inject({
          method: "POST",
          url: "/api/clients",
          headers: headers(),
          payload: { name: "x", websiteUrl },
        })
      ).statusCode,
      400,
    );
  const created = await server().inject({
    method: "POST",
    url: "/api/clients",
    headers: headers(),
    payload: {
      name: "New",
      websiteUrl: "https://new.example.com/path?ignored=1",
    },
  });
  assert.equal(created.statusCode, 202);
  assert.equal(
    (
      await server().inject({
        method: "POST",
        url: "/api/clients",
        headers: headers(),
        payload: { name: "Duplicate", websiteUrl: "https://NEW.example.com/" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await server().inject({ method: "GET", url: "/api/pages" })).statusCode,
    401,
  );
  await db.client.deleteMany({
    where: { id: { in: [client.client.id, created.json().client.id] } },
  });
});
test("crash recovery resumes only unfinished checkpoints and fences stale worker commits", async () => {
  const client = await store.addClient(
    owner,
    "Crash",
    "https://crash.example.com",
  );
  const first = (await store.claim())!;
  assert.equal(first.clientId, client.client.id);
  const selected = [0, 1].map((ordinal) => ({
    ordinal,
    url: `https://crash.example.com/blog/${ordinal}`,
    sourceSitemap: "https://crash.example.com/sitemap.xml",
  }));
  await store.selection(first, selected);
  await store.save(first, selected[0]!, analysis(selected[0]!.url));
  await db.crawlJob.update({
    where: { id: first.id },
    data: { leaseUntil: new Date(0) },
  });
  const second = (await store.claim())!;
  assert.notEqual(second.token, first.token);
  await assert.rejects(
    store.save(first, selected[1]!, analysis(selected[1]!.url)),
    /LEASE_LOST/,
  );
  await assert.rejects(store.renew(first), /LEASE_LOST/);
  assert.deepEqual(
    (await store.pending(second))?.map((p) => p.ordinal),
    [1],
  );
  await store.save(second, selected[1]!, analysis(selected[1]!.url));
  await store.finish(second);
  assert.equal(
    (await store.crawl(owner, client.client.id))?.state,
    "succeeded",
  );
  assert.equal(
    await db.page.count({ where: { clientId: client.client.id } }),
    2,
  );
  const page = await db.page.findFirstOrThrow({
    where: { clientId: client.client.id },
    include: { keywords: true },
  });
  const keyword = page.keywords[0]!;
  await db.rankSnapshot.create({
    data: {
      keywordId: keyword.id,
      capturedAt: new Date("2026-03-08T12:00:00Z"),
      position: 7,
    },
  });
  const range = torontoRange("2026-03-08", "2026-03-08");
  const history = await store.history(owner, page.id, range.start, range.end);
  assert.equal(
    history?.keywords.find((k) => k.id === keyword.id)?.snapshots[0]?.position,
    7,
  );
  assert.equal(
    await store.history(other, page.id, range.start, range.end),
    null,
  );
  await db.client.delete({ where: { id: client.client.id } });
});
test("partial failure preserves successes and concurrent retry schedules only one recovery", async () => {
  const client = await store.addClient(
    owner,
    "Partial",
    "https://partial.example.com",
  );
  const first = (await store.claim())!;
  const selected = [0, 1].map((ordinal) => ({
    ordinal,
    url: `https://partial.example.com/blog/${ordinal}`,
    sourceSitemap: "https://partial.example.com/sitemap.xml",
  }));
  await store.selection(first, selected);
  await store.save(first, selected[0]!, analysis(selected[0]!.url));
  await store.failedPage(first, selected[1]!, "HTTP_503", true);
  await store.finish(first);
  const job = await store.crawl(owner, client.client.id);
  assert.equal(job?.state, "partial");
  assert.equal(job.retryable, true);
  const result = await Promise.allSettled([
    store.retry(owner, client.client.id),
    store.retry(owner, client.client.id),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const next = (await store.claim())!;
  assert.deepEqual(
    (await store.pending(next))?.map((p) => p.ordinal),
    [1],
  );
  await assert.rejects(
    store.save(next, selected[1]!, {
      ...analysis(selected[1]!.url),
      issues: [
        { code: "DUPLICATE", advisory: false, evidence: "x" },
        { code: "DUPLICATE", advisory: false, evidence: "y" },
      ],
    }),
  );
  assert.equal(
    await db.page.count({ where: { clientId: client.client.id } }),
    1,
  );
  assert.equal((await store.pending(next))?.length, 1);
  await store.save(next, selected[1]!, analysis(selected[1]!.url));
  await store.finish(next);
  await db.client.delete({ where: { id: client.client.id } });
});
test("bounded lease recovery ends exhausted jobs without erasing committed pages", async () => {
  const client = await store.addClient(
    owner,
    "Exhaust",
    "https://exhaust.example.com",
  );
  for (let i = 0; i < 3; i++) {
    const claim = (await store.claim())!;
    assert.equal(claim.clientId, client.client.id);
    await db.crawlJob.update({
      where: { id: claim.id },
      data: { leaseUntil: new Date(0) },
    });
  }
  assert.equal(await store.claim(), null);
  assert.equal(
    (await store.crawl(owner, client.client.id))?.error,
    "RECOVERY_EXHAUSTED",
  );
  await db.client.delete({ where: { id: client.client.id } });
});
test("worker executes the shared extraction pipeline and reports selected permanent failures", async () => {
  const client = await store.addClient(
    owner,
    "Worker",
    "https://worker.example.com",
  );
  const worker = new CrawlWorker(
    store,
    () =>
      new Crawler({
        async get(url, allowed) {
          await allowed?.(url);
          if (url.endsWith("robots.txt"))
            return {
              url,
              text: "User-agent: *\nAllow: /\nSitemap: https://worker.example.com/blog.xml",
              contentType: "text/plain",
            };
          if (url.endsWith("blog.xml"))
            return {
              url,
              text: "<urlset><url><loc>https://worker.example.com/blog/good</loc></url><url><loc>https://worker.example.com/blog/bad</loc></url></urlset>",
              contentType: "application/xml",
            };
          if (url.endsWith("/bad")) throw new CrawlError("HTTP_403");
          return { url, text: html, contentType: "text/html" };
        },
      }),
  );
  assert.equal(await worker.runOne(), true);
  const job = await store.crawl(owner, client.client.id);
  assert.equal(job?.state, "partial");
  assert.equal(job.retryable, false);
  assert.equal(job.checkpoints.length, 2);
  assert.equal(job.checkpoints[1]?.error, "HTTP_403");
  await db.client.delete({ where: { id: client.client.id } });
});
test("rank seed reruns are stable, exceed 50k, and identical terms retain independent histories", async () => {
  const client = await db.client.create({
    data: {
      ownerId: owner,
      name: "Rank fixtures",
      websiteUrl: "https://ranks.example.com",
    },
  });
  for (let i = 0; i < 15; i++)
    await db.page.create({
      data: {
        clientId: client.id,
        url: `https://ranks.example.com/blog/${i}`,
        title: `Page ${i}`,
        ruleVersion: "test",
        keywords: {
          create: Array.from({ length: 5 }, (_, k) => ({
            term: `term ${k}`,
            score: 5,
            evidence: "deterministic test fixture",
          })),
        },
      },
    });
  const first = await seedRanks(db, [owner]);
  assert.ok(first.count >= 50000);
  const samples = await db.rankSnapshot.findMany({
    where: { keyword: { page: { clientId: client.id } } },
    orderBy: [{ keywordId: "asc" }, { capturedAt: "asc" }],
    take: 10,
  });
  const second = await seedRanks(db, [owner]);
  assert.equal(second.count, first.count);
  assert.deepEqual(
    await db.rankSnapshot.findMany({
      where: { keyword: { page: { clientId: client.id } } },
      orderBy: [{ keywordId: "asc" }, { capturedAt: "asc" }],
      take: 10,
    }),
    samples,
  );
  const list = await store.pages(owner, client.id, "term 0", 1);
  assert.equal(list.total, 15);
  assert.equal(list.pages.length, 15);
  assert.ok(
    list.pages.every(
      (p) =>
        p.keywords.length === 5 &&
        p.keywords.every((k) => k.latestPosition !== null),
    ),
  );
  assert.equal((await store.pages(other, undefined, "", 1)).total, 0);
  assert.notEqual(
    list.pages[0]!.keywords[0]!.id,
    list.pages[1]!.keywords[0]!.id,
  );
  await assert.rejects(
    db.rankSnapshot.create({
      data: {
        keywordId: list.pages[0]!.keywords[0]!.id,
        capturedAt: new Date(),
        position: 0,
      },
    }),
  );
  await db.client.delete({ where: { id: client.id } });
});
test("forced worker process termination preserves durable page checkpoints", async () => {
  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const client = await store.addClient(
    owner,
    "Killed process",
    "https://crash-process.example.com",
  );
  const child = spawn(
    process.execPath,
    [join(__dirname, "crash-worker.js"), client.client.id],
    { env: process.env, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 10000;
    let committed = false;
    while (Date.now() < deadline) {
      const job = await store.crawl(owner, client.client.id);
      if (job?.checkpoints.some((p) => p.state === "succeeded")) {
        committed = true;
        break;
      }
      await delay(100);
    }
    assert.equal(committed, true);
    const exited = new Promise<void>(resolve => child.once("exit",()=>resolve()));
    child.kill("SIGKILL");
    await exited;
    const job = await store.crawl(owner, client.client.id);
    assert.equal(
      job?.checkpoints.filter((p) => p.state === "succeeded").length,
      1,
    );
    await db.crawlJob.update({
      where: { clientId: client.client.id },
      data: { leaseUntil: new Date(0) },
    });
    const claim = (await store.claim(client.client.id))!;
    const pending = await store.pending(claim);
    assert.deepEqual(
      pending?.map((p) => p.ordinal),
      [1, 2],
    );
    for (const post of pending ?? [])
      await store.save(claim, post, analysis(post.url));
    await store.finish(claim);
    assert.equal(
      await db.page.count({ where: { clientId: client.client.id } }),
      3,
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await db.client.delete({ where: { id: client.client.id } });
  }
});
test("graceful interruption requeues remaining work within its recovery budget", async () => {
  const client = await store.addClient(
    owner,
    "Graceful stop",
    "https://graceful.example.com",
  );
  const signal = new AbortController();
  signal.abort();
  await new CrawlWorker(
    store,
    () =>
      new Crawler({
        async get() {
          throw new Error("Must not fetch after shutdown");
        },
      }),
  ).runOne(client.client.id, signal.signal);
  assert.equal((await store.crawl(owner, client.client.id))?.state, "queued");
  await db.client.delete({ where: { id: client.client.id } });
});

test("F7 recovery exhaustion preserves partial and complete outcomes and unfinished URL reasons",async()=>{
 for(const successes of [1,0,2]) {
  const client=await store.addClient(owner,"Recovery truth",`https://truth-${randomUUID()}.example.com`);
  try {
   const claim=(await store.claim(client.client.id))!;const selected=[0,1].map(ordinal=>({ordinal,url:`${client.client.websiteUrl}/blog/${ordinal}`,sourceSitemap:client.client.websiteUrl+"/blog.xml"}));
   await store.selection(claim,selected);
   for(const post of selected.slice(0,successes))await store.save(claim,post,analysis(post.url));
   await db.crawlJob.update({where:{id:claim.id},data:{attempt:3,leaseUntil:new Date(0)}});
   assert.equal(await store.claim(client.client.id),null);const job=(await store.crawl(owner,client.client.id))!;
   assert.equal(job.state,successes===2?"succeeded":successes?"partial":"failed");
   assert.equal(await db.page.count({where:{clientId:client.client.id}}),successes);
   for(const post of job.checkpoints.filter(p=>p.state!=="succeeded")){assert.equal(post.state,"failed");assert.equal(post.error,"RECOVERY_EXHAUSTED");assert.equal(post.retryable,true);}
   if(successes<2){await store.retry(owner,client.client.id);const retry=(await store.claim(client.client.id))!;assert.equal((await store.pending(retry))?.length,2-successes);}
   else {assert.equal(job.error,null);assert.equal(job.retryable,false);}
  }finally{await db.client.delete({where:{id:client.client.id}});}
 }
});
