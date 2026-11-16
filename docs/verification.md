# Verification evidence

Senior-Level Engineering Improvement Sprint verified on **2026-11-16**, application source through `79044bf`. Baseline was `a7e9372`; the final evidence commit changes documentation only. GSD remains retired. Nothing was published or deployed externally.

## Regression results

| Check | Result |
| --- | --- |
| Locked `npm ci`, local setup, Prisma generation | Passed in a new shallow clone |
| Typecheck and lint | Passed in both working verification copy and fresh clone |
| Backend suite | 40 passed, zero failed/skipped; real isolated PostgreSQL |
| Production browser suite | 30 passed across desktop/mobile Chromium, also repeated in fresh clone |
| Delivery tests | 2 passed; actual minimum Node 22.19.0 and local Node 24.13.0 |
| Runtime image test | Passed; also checked the actual clean-clone Compose API image |
| Compose startup/migrations and Nginx configuration | Passed |
| Live acceptance | Semrush 15 ordered posts, Yoast 15 ordered posts; 30 real analyses |
| Seed reruns | Two successful runs; stable identities and every rank timestamp/value |
| Fresh seeded Docker smoke | Ownership, CSRF, login/logout, encoded-login throttling, real history, production assets passed |
| Accessibility | Zero axe violations, JavaScript errors or horizontal overflow on exercised desktop/mobile detail screens |
| Dependency advisories | Fresh full npm audit: zero; previous seven moderate tooling advisories resolved |

Every approved finding had a failing targeted regression before its implementation change. [Per-finding red/green evidence and commit matrix](evidence/sprint-regressions.json) and [batch details](sprint-verification.md) record the mapping. Controlled HTTP fixtures cover private/mapped/reserved addresses, mixed DNS/rebinding, socket identity, redirects, decompression bounds, retries, cancellation, and overall deadlines. PostgreSQL tests cover ownership, CSRF, concurrent creation/retry, atomic rollback, stale fencing tokens, SIGKILL recovery, partial exhaustion, seed repeatability, independent keyword histories and Toronto DST boundaries.

## Clean clone and real data

Cloned `milestone/M001` at `79044bf` into a new local directory using `--depth 1 --no-local`. Followed README commands: `npm ci`, `npm run setup:local`, `npm run db:generate`, `docker compose up --build -d --wait`, `npm run seed` twice. Only ignored local project/port overrides were added: project `fieldwork-sprint-review`, web 15174, PostgreSQL 55440. This used a new volume; the original application volume was preserved.

Both sites succeeded on their first crawl attempt in this clone. The stored selections exactly match the standalone live command's ordered URL/source-sitemap selections. Both seed runs produced **2 users, 2 clients, 30 real pages, 150 page-keyword associations, 54,750 simulated UTC daily rank snapshots**. Page identities, keyword identities, and rank-value fingerprints are identical across reruns. Fixed anchor: `2026-11-15T12:00:00.000Z`; 365 daily positions per real association. No page, keyword or SEO issue content was fabricated.

[Clean-clone and seed proof](evidence/sprint-clean-clone.json), [standalone live results](evidence/sprint-live.json), [desktop screenshot](evidence/sprint-desktop.png), [mobile screenshot](evidence/sprint-mobile.png).

The local main application was updated at `http://localhost:5188`. Its page/keyword identities and rank timestamps/values were byte-identical across this update: **2 demo users, 3 clients, 45 pages, 225 keywords, 54,750 snapshots**. Historical analyses retain their stored rule versions; corrected extraction v2 applies to new analyses.

## Performance

All four scenarios passed p95 <500 ms with five distinct authenticated concurrent users and **191,625 snapshots during measurement**. Each excluded 30 seconds of warm-up, measured at least 60 seconds and exceeded 1,000 requests. Zero errors. Apple M2, 8 cores, 16 GiB; Node 24.13.0; PostgreSQL 17.12 (aarch64 Alpine).

| Scenario | Previous p95 | Current p95 | Requests | Errors |
| --- | ---: | ---: | ---: | ---: |
| pages-list | 22.74 ms | 14.58 ms | 31,593 | 0 |
| url-search | 59.07 ms | 238.85 ms | 3,999 | 0 |
| keyword-search | 23.15 ms | 76.90 ms | 9,526 | 0 |
| 90-day-history | 44.97 ms | 27.93 ms | 15,570 | 0 |

URL and keyword searches measured slower than the historical baseline (about 4.04x and 3.32x); list and history measured faster. This is a disclosed observed latency increase, not a claim that every metric improved. Page-list/search query code was unchanged in this sprint, and the new ordered/extracted seed dataset and new database differ from the prior run; no causal same-data A/B regression is established. All assignment thresholds pass. No speculative query/index changes were introduced.

[Current benchmark and EXPLAIN (ANALYZE, BUFFERS) evidence](evidence/sprint-benchmark.json) records request counts, hardware, versions and query plans after statistics refresh. Representative latest/history/search DB execution times were 0.061/0.127/0.135 ms (distinct from end-to-end API latency). Temporary benchmark users/pages/ranks were removed afterward, restoring 54,750 snapshots with unchanged seed fingerprints.

## Delivery and limits

- Application runtime excludes Prisma CLI, TypeScript, TypeScript ESLint, ESLint, Vite and Playwright. Argon2 native bindings, generated Prisma Client and Undici load in the actual image. Uncompressed image size decreased from 313,120,548 to 102,224,154 bytes. Migration/seed tooling remains in an explicit separate Docker target.
- Node support is `^22.19.0 || >=24.0.0`, checked against every locked package's engines. CI is configured for the 22.19.0 minimum and Node 24, production frontend browser tests, fresh dependency audit, actual runtime contents and Nginx config validation. Commands passed locally; no hosted Actions run is claimed.
- **F6 remains deferred:** discovery prefetches up to fifteen documents before persisting the selection. Robots-compliant discovery can show 0/0 for minutes; a crash may repeat downloads. Bounded prefetch/cache keeps subsequent analysis deterministic and avoids refetching within one operation. Incremental discovery/checkpoint redesign was explicitly excluded.
- English/static HTML, heuristic blog eligibility and phrase extraction, future live-site restrictions, simulated rankings, and mobile Chromium emulation rather than physical Safari remain assignment limits. Two third-party Zod annotation warnings remain nonblocking; production JS is 327,027 bytes (about 99.63 kB gzip).
- Targeted tracked-text scan found no private-key/cloud-token/GitHub-token markers; `.env` is untracked. This is not an exhaustive secret-history audit.

Ready for public GitHub submission within the approved assignment scope, with F6 disclosed. Publication and external deployment still require explicit authorization.

## Historical baseline

Before this sprint, `a7e9372` recorded 30 backend and 20 browser tests, the previous clean-clone proof and [previous benchmark](benchmark-results.json). Archived AI/GSD attribution is preserved; older committed evidence remains in Git history; current results above supersede historical development-bundle/advisory observations.
