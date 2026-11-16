import { setTimeout as delay } from "node:timers/promises";
import type { TrackerStore, JobClaim } from "./tracker";
import { TrackerError } from "./tracker";
import { Crawler } from "./crawler";
import { CrawlError } from "./crawl-contract";
export class CrawlWorker {
  constructor(
    private readonly store: TrackerStore,
    private readonly makeCrawler: (signal?: AbortSignal) => Crawler,
  ) {}
  async runOne(clientId?: string, signal?: AbortSignal): Promise<boolean> {
    const claim = await this.store.claim(clientId);
    if (!claim) return false;
    await this.process(claim, signal);
    return true;
  }
  async process(claim: JobClaim, signal?: AbortSignal): Promise<void> {
    const lease = new AbortController();
    const operation = signal ? AbortSignal.any([signal,lease.signal]) : lease.signal;
    const crawler = this.makeCrawler(operation);
    let lost = false;
    const heartbeat = setInterval(() => {
      void this.store.renew(claim).catch(() => {
        lost = true;
        lease.abort();
      });
    }, 15000);
    try {
      if (signal?.aborted) throw new CrawlError("INTERRUPTED", true);
      let selected = await this.store.pending(claim);
      if (selected === null) {
        await this.store.selection(
          claim,
          await crawler.discover(claim.websiteUrl),
        );
        selected = await this.store.pending(claim);
      }
      for (const post of selected ?? []) {
        if (signal?.aborted) throw new CrawlError("INTERRUPTED", true);
        if (lost) throw new TrackerError(409, "LEASE_LOST");
        try {
          const page = await crawler.analyze(post.url);
          if (lost) throw new TrackerError(409, "LEASE_LOST");
          await this.store.save(claim, post, page);
        } catch (e) {
          if (e instanceof TrackerError) throw e;
          if (!(e instanceof CrawlError) || e.code === "INTERRUPTED") throw e;
          await this.store.failedPage(claim, post, e.code, e.retryable);
        }
      }
      await this.store.finish(claim);
      console.log(
        JSON.stringify({
          event: "crawl_finished",
          jobId: claim.id,
          clientId: claim.clientId,
        }),
      );
    } catch (e) {
      if (lost || (e instanceof TrackerError && e.code === "LEASE_LOST")) return;
      await this.store.finish(claim, {
        code: e instanceof CrawlError ? e.code : "WORKER_FAILURE",
        retryable: e instanceof CrawlError ? e.retryable : true,
      });
      console.log(
        JSON.stringify({
          event: "crawl_failed",
          jobId: claim.id,
          clientId: claim.clientId,
          code: e instanceof CrawlError ? e.code : "WORKER_FAILURE",
        }),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  async loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        if (!(await this.runOne(undefined, signal)))
          await delay(1000, undefined, { signal });
      } catch {
        if (!signal.aborted) {
          console.error(JSON.stringify({ event: "worker_unavailable" }));
          await delay(1000);
        }
      }
    }
  }
}
