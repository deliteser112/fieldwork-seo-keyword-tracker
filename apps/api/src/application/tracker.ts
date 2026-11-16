import { Temporal } from "@js-temporal/polyfill";
import type { PageAnalysis, Selection } from "./crawler";
export class TrackerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function torontoRange(
  from: string,
  to: string,
): { start: Date; end: Date } {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      throw new Error();
    const first = Temporal.PlainDate.from(from),
      last = Temporal.PlainDate.from(to);
    if (
      Temporal.PlainDate.compare(first, last) > 0 ||
      first.until(last).days > 3660
    )
      throw new Error();
    return {
      start: new Date(
        first.toZonedDateTime("America/Toronto").epochMilliseconds,
      ),
      end: new Date(
        last
          .add({ days: 1 })
          .toZonedDateTime("America/Toronto").epochMilliseconds,
      ),
    };
  } catch {
    throw new TrackerError(400, "INVALID_DATE_RANGE");
  }
}
export interface JobClaim {
  id: string;
  clientId: string;
  websiteUrl: string;
  token: string;
}
export interface Checkpoint extends Selection {
  state: string;
  error: string | null;
  retryable: boolean;
}
export interface JobView {
  id: string;
  state: string;
  attempt: number;
  error: string | null;
  retryable: boolean;
  checkpoints: Checkpoint[];
}
export interface PageView {
  id: string;
  clientId: string;
  url: string;
  title: string;
  ruleVersion: string;
  crawledAt: Date;
  keywords: {
    id: string;
    term: string;
    score: number;
    evidence: string;
    latestPosition: number | null;
  }[];
  issues: { code: string; advisory: boolean; evidence: string }[];
}
export interface HistoryView {
  timezone: string;
  simulated: boolean;
  keywords: {
    id: string;
    term: string;
    snapshots: { capturedAt: Date; position: number }[];
  }[];
}
export interface TrackerStore {
  addClient(
    ownerId: string,
    name: string,
    url: string,
  ): Promise<{
    client: { id: string; name: string; websiteUrl: string };
    jobId: string;
  }>;
  crawl(ownerId: string, clientId: string): Promise<JobView | null>;
  retry(ownerId: string, clientId: string): Promise<void>;
  pages(
    ownerId: string,
    clientId: string | undefined,
    search: string,
    page: number,
  ): Promise<{
    pages: PageView[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  page(ownerId: string, id: string): Promise<PageView | null>;
  history(
    ownerId: string,
    id: string,
    start: Date,
    end: Date,
  ): Promise<HistoryView | null>;
  claim(clientId?: string): Promise<JobClaim | null>;
  renew(claim: JobClaim): Promise<void>;
  selection(claim: JobClaim, selected: Selection[]): Promise<void>;
  pending(claim: JobClaim): Promise<Checkpoint[] | null>;
  save(
    claim: JobClaim,
    selected: Selection,
    analysis: PageAnalysis,
  ): Promise<void>;
  failedPage(
    claim: JobClaim,
    selected: Selection,
    code: string,
    retryable: boolean,
  ): Promise<void>;
  finish(
    claim: JobClaim,
    error?: { code: string; retryable: boolean },
  ): Promise<void>;
}
