import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
export function createDatabase(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
    }),
  });
}

export function createReadiness(db: PrismaClient) {
  return {
    async ready(): Promise<void> {
      await db.$queryRaw`SELECT 1`;
    },
  };
}
