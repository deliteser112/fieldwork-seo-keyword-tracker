import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
export const SEED_ANCHOR = "2026-11-15T12:00:00.000Z";
export async function seedRanks(db: PrismaClient, ownerIds: string[]) {
  const keywords = await db.keyword.findMany({
    where: { page: { client: { ownerId: { in: ownerIds } } } },
    include: { page: { include: { client: true } } },
    orderBy: { id: "asc" },
  });
  if (!keywords.length) throw new Error("No real extracted keywords available");
  const days = Math.max(365, Math.ceil(50000 / keywords.length));
  if (days > 3660)
    throw new Error("Too few extracted associations for bounded seed history");
  for (const keyword of keywords) {
    const data = Array.from({ length: days }, (_, day) => {
      const capturedAt = new Date(Date.parse(SEED_ANCHOR) - day * 86400000);
      const digest = createHash("sha256")
        .update(
          `v1|${keyword.page.client.websiteUrl}|${keyword.page.url}|${keyword.term}|${capturedAt.toISOString()}`,
        )
        .digest();
      return {
        keywordId: keyword.id,
        capturedAt,
        position: 1 + (digest.readUInt32BE(0) % 100),
      };
    });
    await db.rankSnapshot.createMany({ data, skipDuplicates: true });
  }
  return {
    pairs: keywords.length,
    days,
    count: await db.rankSnapshot.count({
      where: { keyword: { page: { client: { ownerId: { in: ownerIds } } } } },
    }),
    anchor: SEED_ANCHOR,
  };
}
