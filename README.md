# Fieldwork — Agency keyword tracker

React/Vite, NestJS/Fastify, strict TypeScript and PostgreSQL. Four screens: sign in, searchable pages, Toronto-date keyword history, and background Add Client. **Only rank positions are simulated.** Pages, suggested keywords and SEO findings come from real websites.

## Run from a clean clone
Node 22.19+ (22.x) or Node 24+ and Docker Compose are required. Run from the repository root:
```sh
npm ci
npm run setup:local
npm run db:generate
docker compose up --build -d --wait
npm run seed
```
Open [localhost:5173](http://localhost:5173). Local demo users: `agency1@fieldwork.test` (Semrush) and `agency2@fieldwork.test` (Yoast); password for both: `Fieldwork-demo-2026!`. These are deliberately public local demo credentials; seed is disabled in production. Setup creates an ignored random database credential and preserves existing `.env`.

Seed discovers each site's blog sitemap generically, ingests its first 15 eligible posts in sitemap order, and creates ≥50,000 repeatable UTC daily snapshots. Reruns preserve identities/results and include new crawled keywords owned by the demo users. Live denial exits unsuccessfully; sites can change or restrict access. Add Client creates pages without rankings until seed runs again.

## Verify
```sh
npm run typecheck && npm run lint && npm run build
npm run test:delivery
npm audit
npm test
npx playwright install chromium
npm run test:e2e
npm run acceptance:live
npm run benchmark
```
Tests use dedicated `tracker_test`; browser servers use ports 15173/13000 independently of Compose and serve production-built frontend assets. Live acceptance and the six-minute benchmark are separate from deterministic CI. [Sprint results](docs/sprint-verification.md) and [evidence and limits](docs/verification.md) includes measured results and clean-checkout proof.

## Decisions and remaining work
Opaque hashed sessions, Argon2id, origin/CSRF checks and owner predicates protect every resource. The shared crawler pins public DNS destinations, checks redirects and robots rules, bounds resources, and extracts explainable English static-HTML phrases/findings. PostgreSQL leased jobs fence each page transaction and preserve partial success. Seed and Add Client use the same pipeline. Page-specific keyword histories use UTC storage and inclusive Toronto calendar ranges, including DST. Indexed latest-rank lookups avoid loading full histories for lists.

Limits: discovery still prefetches the selected documents before checkpointing (deferred F6), so interruption can repeat work and progress can remain 0/0 during discovery. English/static HTML only; heuristic blog eligibility/extraction; standard HTTP/HTTPS ports; no actual Google ranking, hosted deployment, registration/password reset, external monitoring or backup/restore proof. Mobile tests emulate Chromium, not physical Safari. [Engineering details](docs/engineering.md) explain budgets, recovery, and seed semantics. Public GitHub submission remains unpublished pending authorization.

AI: OpenAI Codex assisted planning, implementation and tests. GSD was used initially and then retired; its records are archived. Ongoing work uses ordinary project docs and incremental Git commits.
