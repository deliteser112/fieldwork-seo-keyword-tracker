import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { createDatabase } from "../apps/api/src/infrastructure/database";
import { PrismaTrackerStore } from "../apps/api/src/infrastructure/tracker-store";
import { Crawler } from "../apps/api/src/application/crawler";
import { CrawlWorker } from "../apps/api/src/application/worker";
const db = createDatabase(process.env.DATABASE_URL!);
if (new URL(process.env.DATABASE_URL!).pathname !== "/tracker_test")
  throw new Error("Dedicated test DB required");
let owner = "";
let pageId = "";
const email = `browser-${randomUUID()}@example.test`;
const password = randomUUID();
test.beforeAll(async () => {
  owner = (
    await db.user.create({
      data: { email, passwordHash: await argon2.hash(password) },
    })
  ).id;
  const client = await db.client.create({
    data: {
      ownerId: owner,
      name: "History client",
      websiteUrl: "https://history.example.com",
    },
  });
  for (let i = 0; i < 21; i++) {
    const page = await db.page.create({
      data: {
        clientId: client.id,
        url: `https://history.example.com/blog/${i}`,
        title: `Field notes ${i}`,
        ruleVersion: "browser-fixture",
        keywords: {
          create: {
            term: "search visibility",
            score: 8,
            evidence: "Appears repeatedly in main text",
          },
        },
      },
      include: { keywords: true },
    });
    if (i === 0) {
      pageId = page.id;
      await db.rankSnapshot.createMany({
        data: [
          {
            keywordId: page.keywords[0]!.id,
            capturedAt: new Date("2026-03-08T04:30:00Z"),
            position: 11,
          },
          {
            keywordId: page.keywords[0]!.id,
            capturedAt: new Date("2026-03-08T12:00:00Z"),
            position: 8,
          },
        ],
      });
    }
  }
});
test.afterAll(async () => {
  await db.user.deleteMany({ where: { id: owner } });
  await db.$disconnect();
});
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  test.setTimeout(100000);
  let responsePromise = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/login"),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  let response = await responsePromise;
  if (response.status() === 429) {
    const seconds = Number(response.headers()["retry-after"] ?? 60);
    await delay((Math.min(60, Math.max(1, seconds)) + 1) * 1000);
    responsePromise = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    response = await responsePromise;
  }
  expect(response.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "History client", exact: true }),
  ).toBeVisible();
}
test("pages filters, pagination, Toronto history and accessible detail", async ({
  page,
}, info) => {
  await signIn(page);
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(page.getByText("Page 1 · 21 pages")).toBeVisible();
  await expect(
    page.getByText("No rank", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2 · 21 pages")).toBeVisible();
  await page.getByLabel("Search URL or keyword").fill("search visibility");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Page 1 · 21 pages")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.goto(`/#pages/${pageId}`);
  await expect(
    page.getByRole("heading", { name: "Field notes 0", exact: true }),
  ).toBeVisible();
  await page.getByLabel("From (Toronto)").fill("2026-03-08");
  await page.getByLabel("To (Toronto)").fill("2026-03-08");
  await page.getByRole("button", { name: "Update history" }).click();
  await expect(
    page.getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "11", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Appears repeatedly in main text", { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("heading", { name: "Page detail", exact: true }).focus();
  await page.screenshot({
    path: info.outputPath("page-detail.png"),
    fullPage: true,
  });
  await page.getByLabel("From (Toronto)").fill("2026-04-01");
  await page.getByLabel("To (Toronto)").fill("2026-04-02");
  await page.getByRole("button", { name: "Update history" }).click();
  await expect(
    page.getByText("No rank snapshots in this date range."),
  ).toBeVisible();
});
test("add client schedules durable work, shows progress and rejects duplicates", async ({
  page,
}, info) => {
  await signIn(page);
  await page.getByRole("link", { name: "Add client", exact: true }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Client name").fill("Crawl browser client");
  const site = `https://browser-${randomUUID()}.example.com`;
  await page.getByLabel("Website URL").fill(site);
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Crawl browser client", exact: true }),
  ).toBeVisible();
  const client = await db.client.findUniqueOrThrow({
    where: { ownerId_websiteUrl: { ownerId: owner, websiteUrl: site } },
  });
  const worker = new CrawlWorker(
    new PrismaTrackerStore(db),
    () =>
      new Crawler({
        async get(url, allowed) {
          await allowed?.(url);
          return {
            url,
            contentType: url.endsWith("robots.txt")
              ? "text/plain"
              : url.endsWith(".xml")
                ? "application/xml"
                : "text/html",
            text: url.endsWith("robots.txt")
              ? `User-agent: *\nAllow: /\nSitemap: ${site}/blog.xml`
              : url.endsWith(".xml")
                ? `<urlset><url><loc>${site}/blog/first</loc></url></urlset>`
                : "<title>Website visibility guide</title><article><h1>Website visibility</h1><p>Website visibility improves search visibility. Website visibility needs useful search content. Search visibility needs website visibility and helpful content.</p></article>",
          };
        },
      }),
  );
  await worker.runOne(client.id);
  await expect(page.getByRole("status")).toContainText("succeeded", {
    timeout: 10000,
  });
  await page.screenshot({
    path: info.outputPath("crawl-complete.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Add client", exact: true }).click();
  await page.getByLabel("Client name").fill("Duplicate");
  await page.getByLabel("Website URL").fill(site);
  await page.getByRole("button", { name: "Add client", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "already in your workspace",
  );
  await db.client.delete({ where: { id: client.id } });
});

test("navigation cancels stalled pages without disabling Add Client or changing skip-link destinations", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/pages?**", () => {});
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Loading website insights…",
  );
  await page.getByRole("link", { name: "Add client", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add client", exact: true }),
  ).toBeEnabled();
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await skip.click();
  await expect(
    page.getByRole("heading", { name: "Add a client", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/pages?**");
});
