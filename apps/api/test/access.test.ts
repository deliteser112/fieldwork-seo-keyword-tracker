import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createDatabase } from "../src/infrastructure/database";
import * as argon2 from "argon2";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { PrismaIdentityStore } from "../src/infrastructure/identity";

const config = loadConfig();
if (
  new URL(config.DATABASE_URL).pathname !== "/tracker_test" ||
  config.NODE_ENV !== "test"
)
  throw new Error(
    "Tests require dedicated tracker_test database and NODE_ENV=test",
  );
const db = createDatabase(config.DATABASE_URL);
let app: Awaited<ReturnType<typeof createApp>>;
const password = randomBytes(24).toString("hex");
const emailA = `a-${randomUUID()}@example.test`;
const emailB = `b-${randomUUID()}@example.test`;
let ownerA = "";
let ownerB = "";
let ownClient = "";
let otherClient = "";
const origin = config.APP_ORIGIN;
function server() {
  return app.getHttpAdapter().getInstance();
}
async function login(email = emailA, ip = "127.0.0.1") {
  const res = await server().inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: ip,
    headers: { origin },
    payload: { email, password },
  });
  assert.equal(res.statusCode, 200);
  const cookie = (res.headers["set-cookie"] as string).split(";")[0]!;
  const body = res.json<{
    user: { id: string; email: string };
    csrfToken: string;
  }>();
  return { cookie, body, res };
}
before(async () => {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  ownerA = (await db.user.create({ data: { email: emailA, passwordHash } })).id;
  ownerB = (await db.user.create({ data: { email: emailB, passwordHash } })).id;
  ownClient = (
    await db.client.create({
      data: {
        ownerId: ownerA,
        name: "Owned agency client",
        websiteUrl: "https://example.com",
      },
    })
  ).id;
  otherClient = (
    await db.client.create({
      data: {
        ownerId: ownerB,
        name: "Other agency client",
        websiteUrl: "https://example.org",
      },
    })
  ).id;
  app = await createApp(config);
});
after(async () => {
  if (app) await app.close();
  await db.user.deleteMany({
    where: { id: { in: [ownerA, ownerB].filter(Boolean) } },
  });
  await db.$disconnect();
});
test("config validates without leaking values; production requires secure origin/cookies", () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: "invalid" }),
    /configuration keys/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...process.env,
        NODE_ENV: "production",
        COOKIE_SECURE: "false",
      }),
    /HTTPS/,
  );
});
test("login stores only hash, sets secure browser attributes, and survives refresh", async () => {
  const { cookie, body, res } = await login();
  assert.ok((res.headers["set-cookie"] as string).includes("HttpOnly"));
  assert.ok((res.headers["set-cookie"] as string).includes("SameSite=Lax"));
  const token = cookie.split("=")[1]!;
  const record = await db.session.findUnique({
    where: { tokenHash: createHash("sha256").update(token).digest("hex") },
  });
  assert.ok(record && record.tokenHash !== token);
  const refresh = await server().inject({
    method: "GET",
    url: "/api/auth/session",
    headers: { cookie },
  });
  assert.equal(refresh.statusCode, 200);
  assert.equal(refresh.json().user.id, ownerA);
  assert.ok(refresh.json().csrfToken === body.csrfToken);
  assert.equal(refresh.headers["cache-control"], "no-store");
});
test("bad credentials, unknown user and missing cookie return generic 401", async () => {
  for (const email of [emailA, "unknown@example.test"]) {
    const res = await server().inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin },
      payload: { email, password: "incorrect" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, "UNAUTHENTICATED");
  }
  assert.equal(
    (await server().inject({ method: "GET", url: "/api/clients" })).statusCode,
    401,
  );
});
test("rejects login CSRF, malformed payload and extra properties", async () => {
  const denied = await server().inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "https://attacker.invalid" },
    payload: { email: emailA, password },
  });
  assert.equal(denied.statusCode, 403);
  const extra = await server().inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin },
    payload: { email: emailA, password, ownerId: ownerB },
  });
  assert.equal(extra.statusCode, 400);
});
test("every client query is owner scoped; foreign and nonexistent IDs indistinguishable", async () => {
  const { cookie } = await login();
  const list = await server().inject({
    method: "GET",
    url: "/api/clients",
    headers: { cookie },
  });
  assert.deepEqual(
    list.json().clients.map((c: { id: string }) => c.id),
    [ownClient],
  );
  assert.equal(
    (
      await server().inject({
        method: "GET",
        url: `/api/clients/${ownClient}`,
        headers: { cookie },
      })
    ).statusCode,
    200,
  );
  for (const id of [otherClient, randomUUID(), "invalid"]) {
    assert.equal(
      (
        await server().inject({
          method: "GET",
          url: `/api/clients/${id}`,
          headers: { cookie },
        })
      ).statusCode,
      404,
    );
  }
  const b = await login(emailB, "127.0.0.2");
  assert.equal(
    (
      await server().inject({
        method: "GET",
        url: `/api/clients/${ownClient}`,
        headers: { cookie: b.cookie },
      })
    ).statusCode,
    404,
  );
});
test("logout requires bound CSRF and revokes the session", async () => {
  const { cookie, body } = await login();
  const otherSession = await login(emailB, "127.0.0.8");
  for (const token of [
    "",
    "bad",
    "é".repeat(64),
    otherSession.body.csrfToken,
  ]) {
    const res = await server().inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin, cookie, "x-csrf-token": token },
    });
    assert.equal(res.statusCode, 403);
  }
  const crossOrigin = await server().inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: {
      origin: "https://attacker.invalid",
      cookie,
      "x-csrf-token": body.csrfToken,
    },
  });
  assert.equal(crossOrigin.statusCode, 403);
  const done = await server().inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { origin, cookie, "x-csrf-token": body.csrfToken },
  });
  assert.equal(done.statusCode, 204);
  assert.equal(
    (
      await server().inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie },
      })
    ).statusCode,
    401,
  );
});
test("expired sessions cannot access data", async () => {
  const { cookie } = await login(emailB, "127.0.0.3");
  await db.session.updateMany({
    where: { userId: ownerB },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (
      await server().inject({
        method: "GET",
        url: "/api/clients",
        headers: { cookie },
      })
    ).statusCode,
    401,
  );
});
test("secure cookie configuration and absolute expiry are enforced", async () => {
  const secureOrigin = "https://agency.example.test";
  const secureApp = await createApp({
    ...config,
    APP_ORIGIN: secureOrigin,
    COOKIE_SECURE: "true",
    SESSION_TTL_SECONDS: 120,
  });
  try {
    const started = Date.now();
    const response = await secureApp
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: secureOrigin },
        payload: { email: emailA, password },
      });
    assert.equal(response.statusCode, 200);
    const header = response.headers["set-cookie"] as string;
    assert.ok(header.includes("; Secure"));
    assert.ok(header.includes("Max-Age=120"));
    const token = header.split(";")[0]!.split("=")[1]!;
    const session = await db.session.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    assert.ok(
      session &&
        session.expiresAt.getTime() >= started + 120000 &&
        session.expiresAt.getTime() <= Date.now() + 120000,
    );
  } finally {
    await secureApp.close();
  }
});
test("successful login rotates the browser session; failed login preserves it", async () => {
  const { cookie } = await login(emailA, "127.0.0.20");
  const request = {
    method: "POST" as const,
    url: "/api/auth/login",
    remoteAddress: "127.0.0.21",
    headers: { origin, cookie },
  };
  const failed = await server().inject({
    ...request,
    payload: { email: emailA, password: "incorrect" },
  });
  assert.equal(failed.statusCode, 401);
  assert.equal(failed.headers["set-cookie"], undefined);
  const session = () => server().inject({
    method: "GET", url: "/api/auth/session", headers: { cookie },
  });
  assert.equal((await session()).statusCode, 200);
  const rotated = await server().inject({ ...request, payload: { email: emailA, password } });
  assert.equal(rotated.statusCode, 200);
  assert.notEqual((rotated.headers["set-cookie"] as string).split(";")[0], cookie);
  assert.equal((await session()).statusCode, 401);
});

test("real PostgreSQL insertion failure rolls back pruning and previous-session revocation", async () => {
  const store = new PrismaIdentityStore(db);
  await db.session.deleteMany({ where: { userId: ownerB } });
  const expiresAt = new Date(Date.now() + 60000);
  const hashes = Array.from({ length: 10 }, () => randomBytes(32).toString("hex"));
  for (const tokenHash of hashes) await store.createSession(ownerB, tokenHash, expiresAt);
  // A collision with a different account survives pruning, forcing INSERT to fail.
  const collision = randomBytes(32).toString("hex");
  await store.createSession(ownerA, collision, expiresAt);
  const expiredHash = randomBytes(32).toString("hex");
  await db.session.create({ data: { userId: ownerB, tokenHash: expiredHash, expiresAt: new Date(0) } });
  const before = await db.session.findMany({ where: { userId: ownerB }, orderBy: { id: "asc" } });
  await assert.rejects(store.createSession(ownerB, collision, expiresAt, hashes[9]), { code: "P2002" });
  assert.deepEqual(await db.session.findMany({ where: { userId: ownerB }, orderBy: { id: "asc" } }), before);
  assert.ok(await store.principalBySession(hashes[9]!, new Date()));
});

test("concurrent session creation stays capped at ten per account", async () => {
  const store = new PrismaIdentityStore(db);
  await Promise.all(Array.from({ length: 15 }, () => store.createSession(
    ownerB, randomBytes(32).toString("hex"), new Date(Date.now() + 60000),
  )));
  assert.equal(await db.session.count({ where: { userId: ownerB } }), 10);
});

test("malformed tokens, missing origin and invalid login bodies fail safely", async () => {
  for (const token of ["bad", "a".repeat(63), "g".repeat(64)]) {
    const res = await server().inject({ method: "GET", url: "/api/clients", headers: { cookie: `tracker_session=${token}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().requestId, res.headers["x-request-id"]);
  }
  const missingOrigin = await server().inject({ method: "POST", url: "/api/auth/login", payload: { email: emailA, password }, remoteAddress: "127.0.0.22" });
  assert.equal(missingOrigin.statusCode, 403);
  for (const payload of [{}, { email: "bad", password }, { email: emailA, password: "" }, { email: emailA, password: "x".repeat(257) }]) {
    const res = await server().inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload, remoteAddress: "127.0.0.23" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers["set-cookie"], undefined);
  }
});

test("database connection failure returns sanitized 503 while liveness remains available", async () => {
  const unavailable = new URL(config.DATABASE_URL);
  unavailable.port = "1";
  // The pg adapter connects lazily: readiness and auth must fail closed at request time.
  const offline = await createApp({ ...config, DATABASE_URL: unavailable.toString() });
  try {
    const transport = offline.getHttpAdapter().getInstance();
    assert.equal((await transport.inject({ method: "GET", url: "/api/live" })).statusCode, 200);
    for (const request of [
      { method: "GET" as const, url: "/api/health" },
      { method: "POST" as const, url: "/api/auth/login", headers: { origin }, payload: { email: emailA, password } },
      { method: "GET" as const, url: "/api/clients", headers: { cookie: `tracker_session=${"a".repeat(64)}` } },
    ]) {
      const res = await transport.inject(request);
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { error: "SERVICE_UNAVAILABLE", requestId: res.headers["x-request-id"] });
      assert.equal(res.headers["set-cookie"], undefined);
    }
  } finally {
    await offline.close();
  }
});

test("login rate limiting bounds password hashing attempts", async () => {
  let last = 0;
  for (let i = 0; i < 11; i++)
    last = (
      await server().inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "127.0.0.9",
        headers: { origin },
        payload: { email: "nobody@example.test", password: "incorrect" },
      })
    ).statusCode;
  assert.equal(last, 429);
});

// F1: the matched route, including percent-encoded aliases, must share one IP bucket.
test("encoded login aliases cannot bypass the canonical login rate limit", async () => {
  const urls=["/api/auth/login","/%61pi/auth/login","/api/%61uth/login","/api/auth/%6cogin"];
  for(let n=0;n<12;n++) {
    const result=await server().inject({method:"POST",url:urls[n%urls.length]!,remoteAddress:"198.51.100.230",headers:{origin},payload:{email:"missing-alias@example.test",password:"incorrect"}});
    assert.equal(result.statusCode,n<10?401:429,`attempt ${n+1} using ${urls[n%urls.length]}`);
  }
});
