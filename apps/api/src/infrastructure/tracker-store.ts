import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TrackerStore, JobClaim, PageView } from "../application/tracker";
import { TrackerError } from "../application/tracker";
import type { PageAnalysis, Selection } from "../application/crawler";

const pageInclude = { keywords: true, issues: true };
type PageRow = Prisma.PageGetPayload<{ include: typeof pageInclude }>;
function view(p: PageRow, latest: Map<string, number>): PageView {
  return {
    id: p.id,
    clientId: p.clientId,
    url: p.url,
    title: p.title,
    ruleVersion: p.ruleVersion,
    crawledAt: p.crawledAt,
    keywords: p.keywords.map((k) => ({
      id: k.id,
      term: k.term,
      score: k.score,
      evidence: k.evidence,
      latestPosition: latest.get(k.id) ?? null,
    })),
    issues: p.issues.map((i) => ({
      code: i.code,
      advisory: i.advisory,
      evidence: i.evidence,
    })),
  };
}
export class PrismaTrackerStore implements TrackerStore {
  constructor(readonly db: PrismaClient) {}
  async addClient(ownerId: string, name: string, url: string) {
    try {
      const client = await this.db.client.create({
        data: { ownerId, name, websiteUrl: url, crawl: { create: {} } },
        include: { crawl: true },
      });
      return {
        client: {
          id: client.id,
          name: client.name,
          websiteUrl: client.websiteUrl,
        },
        jobId: client.crawl!.id,
      };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      )
        throw new TrackerError(409, "DUPLICATE_WEBSITE");
      throw e;
    }
  }
  async crawl(ownerId: string, clientId: string) {
    const client = await this.db.client.findFirst({
      where: { id: clientId, ownerId },
      include: {
        crawl: { include: { checkpoints: { orderBy: { ordinal: "asc" } } } },
      },
    });
    if (!client) throw new TrackerError(404, "NOT_FOUND");
    if (!client.crawl) return null;
    const j = client.crawl;
    return {
      id: j.id,
      state: j.state,
      attempt: j.attempt,
      error: j.error,
      retryable: j.retryable,
      checkpoints: j.checkpoints.map((c) => ({
        ordinal: c.ordinal,
        url: c.url,
        sourceSitemap: c.sourceSitemap,
        state: c.state,
        error: c.error,
        retryable: c.retryable,
      })),
    };
  }
  async retry(ownerId: string, clientId: string) {
    await this.db.$transaction(async (tx) => {
      // Same row lock as worker claims/commits; two retries cannot enqueue twice.
      const rows = await tx.$queryRaw<
        { id: string; state: string; retryable: boolean }[]
      >`SELECT j.id,j.state,j.retryable FROM "CrawlJob" j JOIN "Client" c ON c.id=j."clientId" WHERE c.id=${clientId}::uuid AND c."ownerId"=${ownerId}::uuid FOR UPDATE OF j`;
      const job = rows[0];
      if (!job) throw new TrackerError(404, "NOT_FOUND");
      if (!["failed", "partial"].includes(job.state) || !job.retryable)
        throw new TrackerError(409, "NOT_RETRYABLE");
      await tx.crawlPage.updateMany({
        where: { jobId: job.id, state: "failed", retryable: true },
        data: { state: "pending", error: null, retryable: false },
      });
      await tx.crawlJob.update({
        where: { id: job.id },
        data: {
          state: "queued",
          attempt: 0,
          claimToken: null,
          leaseUntil: null,
          error: null,
          retryable: false,
          availableAt: new Date(),
        },
      });
    });
  }
  async pages(
    ownerId: string,
    clientId: string | undefined,
    search: string,
    page: number,
  ) {
    const where: Prisma.PageWhereInput = {
      client: { ownerId },
      ...(clientId ? { clientId } : {}),
      ...(search
        ? {
            OR: [
              { url: { contains: search, mode: "insensitive" } },
              {
                keywords: {
                  some: { term: { contains: search, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    };
    return this.db.$transaction(
      async (tx) => {
        const total = await tx.page.count({ where });
        const rows = await tx.page.findMany({
          where,
          orderBy: { id: "asc" },
          skip: (page - 1) * 20,
          take: 20,
          include: pageInclude,
        });
        const latest = await this.latest(
          tx,
          rows.flatMap((p) => p.keywords.map((k) => k.id)),
        );
        return {
          pages: rows.map((p) => view(p, latest)),
          total,
          page,
          pageSize: 20,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }
  private async latest(tx: Prisma.TransactionClient, ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await tx.$queryRaw<
      { id: string; position: number | null }[]
    >`SELECT k.id,s.position FROM unnest(${ids}::uuid[]) AS k(id) LEFT JOIN LATERAL (SELECT position FROM "RankSnapshot" WHERE "keywordId"=k.id ORDER BY "capturedAt" DESC LIMIT 1) s ON true`;
    return new Map(
      rows
        .filter(
          (r): r is { id: string; position: number } => r.position !== null,
        )
        .map((r) => [r.id, r.position]),
    );
  }
  async page(ownerId: string, id: string) {
    const p = await this.db.page.findFirst({
      where: { id, client: { ownerId } },
      include: pageInclude,
    });
    return p
      ? view(
          p,
          await this.latest(
            this.db,
            p.keywords.map((k) => k.id),
          ),
        )
      : null;
  }
  async history(ownerId: string, id: string, start: Date, end: Date) {
    const page = await this.db.page.findFirst({
      where: { id, client: { ownerId } },
      include: {
        keywords: {
          orderBy: { term: "asc" },
          include: {
            snapshots: {
              where: { capturedAt: { gte: start, lt: end } },
              orderBy: { capturedAt: "asc" },
            },
          },
        },
      },
    });
    if (!page) return null;
    return {
      timezone: "America/Toronto",
      simulated: true,
      keywords: page.keywords.map((k) => ({
        id: k.id,
        term: k.term,
        snapshots: k.snapshots.map((s) => ({
          capturedAt: s.capturedAt,
          position: s.position,
        })),
      })),
    };
  }
  async claim(clientId?: string): Promise<JobClaim | null> {
    const token = randomUUID();
    return this.db.$transaction(async (tx) => {
      // Exhausted crashed jobs are terminal; successes remain committed.
      const exhausted=await tx.$queryRaw<{id:string;selectionComplete:boolean}[]>`SELECT id,"selectionComplete" FROM "CrawlJob" WHERE state='running' AND "leaseUntil"<clock_timestamp() AND attempt>=3 AND (${clientId ?? null}::uuid IS NULL OR "clientId"=${clientId ?? null}::uuid) FOR UPDATE SKIP LOCKED`;
      for(const job of exhausted){
        const pages=await tx.crawlPage.findMany({where:{jobId:job.id}});
        const successes=pages.filter(page=>page.state==="succeeded").length;
        const complete=job.selectionComplete&&pages.length>0&&successes===pages.length;
        await tx.crawlPage.updateMany({where:{jobId:job.id,state:"pending"},data:{state:"failed",error:"RECOVERY_EXHAUSTED",retryable:true}});
        await tx.crawlJob.update({where:{id:job.id},data:{state:complete?"succeeded":successes?"partial":"failed",error:complete?null:"RECOVERY_EXHAUSTED",retryable:!complete&&(!job.selectionComplete||pages.some(page=>page.state==="pending"||page.retryable)),claimToken:null,leaseUntil:null}});
      }
      const rows = await tx.$queryRaw<
        { id: string; clientId: string }[]
      >`SELECT id,"clientId" FROM "CrawlJob" WHERE ((state='queued' AND "availableAt" <= clock_timestamp()) OR (state='running' AND "leaseUntil" < clock_timestamp() AND attempt < 3)) AND (${clientId ?? null}::uuid IS NULL OR "clientId"=${clientId ?? null}::uuid) ORDER BY "availableAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      const job = rows[0];
      if (!job) return null;
      await tx.$executeRaw`UPDATE "CrawlJob" SET state='running',attempt=attempt+1,"claimToken"=${token}::uuid,"leaseUntil"=clock_timestamp()+interval '60 seconds',"updatedAt"=clock_timestamp() WHERE id=${job.id}::uuid`;
      const client = await tx.client.findUniqueOrThrow({
        where: { id: job.clientId },
      });
      return { ...job, websiteUrl: client.websiteUrl, token };
    });
  }
  private async fence(tx: Prisma.TransactionClient, claim: JobClaim) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "CrawlJob" WHERE id=${claim.id}::uuid AND "claimToken"=${claim.token}::uuid AND state='running' AND "leaseUntil">clock_timestamp() FOR UPDATE`;
    if (!rows.length) throw new TrackerError(409, "LEASE_LOST");
  }
  async renew(claim: JobClaim) {
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, claim);
      await tx.$executeRaw`UPDATE "CrawlJob" SET "leaseUntil"=clock_timestamp()+interval '60 seconds' WHERE id=${claim.id}::uuid`;
    });
  }
  async selection(claim: JobClaim, selected: Selection[]) {
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, claim);
      const j = await tx.crawlJob.findUniqueOrThrow({
        where: { id: claim.id },
      });
      if (j.selectionComplete) return;
      await tx.crawlPage.createMany({
        data: selected.map((s) => ({ ...s, jobId: claim.id })),
      });
      await tx.crawlJob.update({
        where: { id: claim.id },
        data: { selectionComplete: true },
      });
    });
  }
  async pending(claim: JobClaim) {
    const job = await this.db.crawlJob.findFirst({
      where: { id: claim.id, claimToken: claim.token },
      include: {
        checkpoints: {
          where: { state: "pending" },
          orderBy: { ordinal: "asc" },
        },
      },
    });
    if (!job) throw new TrackerError(409, "LEASE_LOST");
    return job.selectionComplete
      ? job.checkpoints.map((c) => ({
          ordinal: c.ordinal,
          url: c.url,
          sourceSitemap: c.sourceSitemap,
          state: c.state,
          error: c.error,
          retryable: c.retryable,
        }))
      : null;
  }
  async save(claim: JobClaim, selected: Selection, analysis: PageAnalysis) {
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, claim);
      const page = await tx.page.upsert({
        where: {
          clientId_url: { clientId: claim.clientId, url: selected.url },
        },
        create: {
          clientId: claim.clientId,
          url: selected.url,
          title: analysis.title,
          ruleVersion: analysis.ruleVersion,
        },
        update: {
          title: analysis.title,
          ruleVersion: analysis.ruleVersion,
          crawledAt: new Date(),
        },
      });
      // Preserve keyword identities/history on reruns. Remove only terms no longer extracted.
      await tx.keyword.deleteMany({
        where: {
          pageId: page.id,
          term: { notIn: analysis.keywords.map((k) => k.term) },
        },
      });
      for (const k of analysis.keywords)
        await tx.keyword.upsert({
          where: { pageId_term: { pageId: page.id, term: k.term } },
          create: { pageId: page.id, ...k },
          update: k,
        });
      await tx.seoIssue.deleteMany({ where: { pageId: page.id } });
      await tx.seoIssue.createMany({
        data: analysis.issues.map((i) => ({ ...i, pageId: page.id })),
      });
      await tx.crawlPage.update({
        where: {
          jobId_ordinal: { jobId: claim.id, ordinal: selected.ordinal },
        },
        data: { state: "succeeded", error: null, retryable: false },
      });
    });
  }
  async failedPage(
    claim: JobClaim,
    selected: Selection,
    code: string,
    retryable: boolean,
  ) {
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, claim);
      await tx.crawlPage.update({
        where: {
          jobId_ordinal: { jobId: claim.id, ordinal: selected.ordinal },
        },
        data: { state: "failed", error: code, retryable },
      });
    });
  }
  async finish(claim: JobClaim, error?: { code: string; retryable: boolean }) {
    await this.db.$transaction(async (tx) => {
      await this.fence(tx, claim);
      const current = await tx.crawlJob.findUniqueOrThrow({
        where: { id: claim.id },
      });
      const interrupted = error?.code === "INTERRUPTED" && current.attempt < 3;
      const checkpoints = await tx.crawlPage.findMany({
        where: { jobId: claim.id },
      });
      const successes = checkpoints.filter(
        (c) => c.state === "succeeded",
      ).length;
      const failures = checkpoints.filter((c) => c.state !== "succeeded");
      await tx.crawlJob.update({
        where: { id: claim.id },
        data: {
          state: interrupted
            ? "queued"
            : error || failures.length
              ? successes
                ? "partial"
                : "failed"
              : "succeeded",
          error: error?.code ?? (failures.length ? "PAGE_FAILURES" : null),
          retryable: error?.retryable ?? failures.some((c) => c.retryable),
          leaseUntil: null,
          claimToken: null,
        },
      });
    });
  }
}
