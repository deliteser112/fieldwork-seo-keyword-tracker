import { test, expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { createDatabase } from "../apps/api/src/infrastructure/database";
import { randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== "/tracker_test"
)
  throw new Error("Browser tests require dedicated test database");
const db = createDatabase(process.env.DATABASE_URL);
let userId = "";
let otherId = "";
const email = `browser-${randomUUID()}@example.test`;
const password = randomBytes(24).toString("hex");
test.beforeAll(async () => {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  userId = (await db.user.create({ data: { email, passwordHash } })).id;
  otherId = (
    await db.user.create({
      data: { email: `other-${randomUUID()}@example.test`, passwordHash },
    })
  ).id;
  await db.client.create({
    data: {
      ownerId: userId,
      name: "Northwind Studio",
      websiteUrl: "https://example.com",
    },
  });
  await db.client.create({
    data: {
      ownerId: otherId,
      name: "Private Other Client",
      websiteUrl: "https://example.org",
    },
  });
});
test.afterAll(async () => {
  await db.user.deleteMany({
    where: { id: { in: [userId, otherId].filter(Boolean) } },
  });
  await db.$disconnect();
});
test("isolated proxy exposes readiness, liveness and correlated safe errors", async ({
  request,
}) => {
  for (const [path, status] of [
    ["health", "ready"],
    ["live", "alive"],
  ]) {
    const response = await request.get(`/api/${path}`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status });
    expect(response.headers()["x-request-id"]).toBeTruthy();
    expect(response.headers()["cache-control"]).toBe("no-store");
  }
  const denied = await request.get("/api/clients");
  expect(denied.status()).toBe(401);
  expect(denied.headers()["x-request-id"]).toBeTruthy();
  expect(await denied.json()).toEqual({
    error: "UNAUTHENTICATED",
    requestId: denied.headers()["x-request-id"],
  });
});
test("accessible sign-in, private workspace, refresh and logout", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email address")).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(password);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Clients", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Northwind Studio", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByText("Private Other Client")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Northwind Studio", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("workspace.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("sign-in.png"),
    fullPage: true,
  });
});
test("foreign client IDs are inaccessible and expired sessions return to sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Northwind Studio", exact: true }),
  ).toBeVisible();
  const otherClient = await db.client.findFirstOrThrow({
    where: { ownerId: otherId },
    select: { id: true },
  });
  const denied = await page.request.get(`/api/clients/${otherClient.id}`);
  expect(denied.status()).toBe(404);
  expect((await denied.json()).error).toBe("NOT_FOUND");
  await db.session.updateMany({
    where: { userId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Sign in to your workspace" }),
  ).toBeVisible();
  expect((await page.request.get("/api/clients")).status()).toBe(401);
});
test("session failures and malformed responses permit retry", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.abort("connectionfailed"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable" }),
  ).toBeVisible();
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { user: null } }),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable" }),
  ).toBeVisible();
  await page.unroute("**/api/auth/session");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
});

test("client failures, empty state and logout failure recover safely", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.route("**/api/clients", (route) =>
    route.fulfill({ json: { clients: [null] } }),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "We couldn’t load your clients.",
  );
  await page.route("**/api/clients", (route) =>
    route.abort("connectionfailed"),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "We couldn’t load your clients.",
  );
  await page.unroute("**/api/clients");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Northwind Studio", exact: true }),
  ).toBeVisible();
  await db.client.deleteMany({ where: { ownerId: userId } });
  try {
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No clients yet" }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.route("**/api/auth/logout", (route) =>
      route.fulfill({ status: 503, json: {} }),
    );
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Could not sign out. Please try again.",
    );
    await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await page.unroute("**/api/auth/logout");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Email address")).toBeVisible();
  } finally {
    await db.client.create({
      data: {
        ownerId: userId,
        name: "Northwind Studio",
        websiteUrl: "https://example.com",
      },
    });
  }
});

test("stalled login times out and rate limits remain actionable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.route("**/api/auth/login", () => {});
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Signing in…" }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in is unavailable. Please try again.",
    { timeout: 15000 },
  );
  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 429, json: {} }),
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});

test("invalid credentials show an accessible actionable error", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  test.setTimeout(90000);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  let submitted = page.waitForResponse(response => response.url().endsWith("/api/auth/login"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  let response = await submitted;
  if (response.status() === 429) {
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    const seconds = Number(response.headers()["retry-after"] ?? 60);
    await delay((Math.min(60, Math.max(1, seconds)) + 1) * 1000);
    submitted = page.waitForResponse(result => result.url().endsWith("/api/auth/login"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    response = await submitted;
  }
  expect(response.status()).toBe(401);
  await expect(page.getByRole("alert")).toHaveText(
    "Email or password is incorrect.",
  );
});
