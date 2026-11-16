import { PrismaClient } from "@prisma/client";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as argon2 from "argon2";
import type { IdentityStore, Credentials } from "../application/access";

export class PrismaIdentityStore implements IdentityStore {
  constructor(private readonly db: PrismaClient) {}
  accountByEmail(email: string) {
    return this.db.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });
  }
  async createSession(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    previousTokenHash?: string,
  ) {
    await this.db.$transaction(async (tx) => {
      // Bound per-account storage and serialize concurrent logins on the user row.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      await tx.session.deleteMany({
        where: { userId, expiresAt: { lte: new Date() } },
      });
      const old = await tx.session.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: 9,
        select: { id: true },
      });
      await tx.session.deleteMany({
        where: { id: { in: old.map((s) => s.id) } },
      });
      if (previousTokenHash) {
        await tx.session.deleteMany({ where: { tokenHash: previousTokenHash } });
      }
      // Rotation and capacity cleanup must roll back if insertion fails.
      await tx.session.create({ data: { userId, tokenHash, expiresAt } });
    });
  }
  async principalBySession(tokenHash: string, now: Date) {
    const session = await this.db.session.findFirst({
      where: { tokenHash, expiresAt: { gt: now } },
      select: { user: { select: { id: true, email: true } } },
    });
    return session?.user ?? null;
  }
  async revokeSession(tokenHash: string) {
    await this.db.session.deleteMany({ where: { tokenHash } });
  }
  clientsFor(ownerId: string) {
    return this.db.client.findMany({
      where: { ownerId },
      select: { id: true, name: true, websiteUrl: true },
      orderBy: { id: "asc" },
      take: 100,
    });
  }
  clientFor(ownerId: string, id: string) {
    return this.db.client.findFirst({
      where: { ownerId, id },
      select: { id: true, name: true, websiteUrl: true },
    });
  }
}
export async function createCredentials(): Promise<Credentials> {
  const dummyHash = await argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  return {
    dummyHash,
    verify: (hash, password) => argon2.verify(hash, password),
    issue: () => randomBytes(32).toString("hex"),
    digest: (token) => createHash("sha256").update(token).digest("hex"),
    // Bound to the random session secret, never a second persisted plaintext token.
    csrf: (token) =>
      createHmac("sha256", token)
        .update("agency-tracker:csrf:v1")
        .digest("hex"),
    matches: (a, b) =>
      /^[a-f0-9]{64}$/.test(b) &&
      timingSafeEqual(Buffer.from(a), Buffer.from(b)),
  };
}
