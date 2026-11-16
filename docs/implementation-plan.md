# Implementation checklist

Continue the existing NestJS/Fastify, strict TypeScript, React/Vite, PostgreSQL and Prisma modular monolith. GSD is retired: archived records remain untouched and are not an execution dependency. Work in this checkout using focused Git commits. Do not publish without explicit authorization.

- [x] Establish fresh baseline; preserve authentication, CSRF, ownership and isolated browser ports.
- [x] Shared connection-safe HTTP crawler, generic ordered sitemap discovery, real evidence-backed extraction; separate live Semrush/Yoast acceptance.
- [x] Transactional Add Client, PostgreSQL leased/fenced crawl worker, durable checkpoints and accurate partial outcomes.
- [x] Repeatable two-user live seed and >=50,000 deterministic UTC page-keyword snapshots; preserve unrelated data.
- [x] Owner-scoped pages search/filter/pagination and Toronto-calendar history; responsive accessible four-screen UI.
- [x] Deterministic CI, recovery/security/browser tests, measured performance and clean-checkout delivery.

## Acceptance contract

Only ranks are simulated. Select the first 15 eligible blog posts in original sitemap order, without site-specific discovery or replacing failed selections. Seed and Add Client share a single crawler. Respect robots/access controls; blocked required live sites remain explicit acceptance failures. Never fabricate keywords/pages/findings. Up to five supported terms per page.

All resource queries enforce owner identity; foreign and missing resources are indistinguishable. Mutations use existing origin/CSRF protection. Sessions remain opaque/hashed, Argon2id passwords and PostgreSQL persistence. Prisma stays in infrastructure, not application/domain types. No Redis, generic queues or microservices.

Jobs use SKIP LOCKED, database-time leases and token-checked short transactions. Network is outside transactions. Preserve successes, bound HTTP attempts to three, reject stale workers. Rankings belong to page-specific keywords, unique by keyword/timestamp; Toronto inclusive dates convert to half-open UTC intervals including DST. Absent ranks remain absent.

Benchmark each list/search/90-day history scenario at p95<500ms using five authenticated concurrent users, >=50k snapshots, 30s excluded warmup, >=60s measurement and >=1000 requests. Record actual results plus EXPLAIN ANALYZE. Deterministic CI excludes live network acceptance. One-page root README documents clean setup, decisions, unfinished work and AI tools. Hosted deployment and public publication are separate from implementation.

## Approved engineering improvement sprint

- [x] Batch 1: canonical-route login throttling (F1).
- [x] Batch 2: sitemap ordering/decoding, structured retryability, supported extraction (F2/F3/F4/F8).
- [x] Batch 3: cancellation/deadlines/lease loss and truthful exhausted recovery (F5/F7).
- [x] Batch 4: visible errors, Add Client retry, displayed filters and date validation (F9–F12).
- [x] Batch 5: production browser artifact, supported Node range and lean runtime (F13–F15).
- [x] Fresh clone, full suites, security, both live sites, stable >=50k seed, dependency/runtime review and benchmark rerun.

F6 remains deferred. Search p95 increased versus the historical run but all required thresholds passed; no listing/search query changes or speculative optimizations were made. [Sprint evidence and remaining limits](sprint-verification.md). Publication remains separately authorized.
