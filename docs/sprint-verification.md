# Engineering improvement sprint

Approved scope: F1–F5 and F7–F15. F6 (incremental discovery/checkpointing) remains deferred. No external publication/deployment is authorized.

Baseline: `a7e9372`, branch `milestone/M001`, clean tracked working tree before edits. Independent audit baseline: 30 backend and 20 browser tests passed. Existing application dataset: 2 users, 3 clients, 45 pages, 225 keywords, 54,750 snapshots.

Red/green evidence is captured per finding before its implementation. Tests use the isolated `tracker_test` database; live data is preserved.

## Batch results

Batch 1 — F1: regression failed at attempt 11 (401 instead of 429) before the fix. Canonical matched-route limiting now passes. Typecheck, lint, 31 backend tests and production build passed. Evidence: F1-red.log and batch1-green.log in the sprint working evidence directory.


Batch 2 — F2/F3/F4/F8: all four targeted tests failed before fixes (dropped sibling map, escaped URL/malformed entry truncation, non-retryable timeout, invented fused terms). All 35 backend tests, typecheck, lint and production builds now pass. XML predefined entities are decoded only after rejecting DTD/custom entity declarations; maps retain declared order. Extraction v2 affects new analyses; existing application records/history were not rewritten.

## Deferred F6

Discovery still prefetches up to fifteen article documents before persisting its selection. Slow robots-compliant crawls can show 0/0 progress, and interrupted discovery can repeat downloaded work. Memory/body limits remain enforced. Incremental discovery/checkpoint redesign is explicitly outside this sprint.

## Batch 3 — F5 and F7

Five new regressions failed first: active HTTP cancellation, a deadline spanning redirects, interruption of robots delays, lease-loss cancellation, and truthful exhausted recovery states. They now pass. Cancellation is propagated through permission waits, DNS, requests, retries and the worker operation; a single 45-second HTTP deadline bounds redirects and retry attempts. Lost leases abort work and cannot commit stale results. Exhaustion preserves successful checkpoints and distinguishes partial, complete and failed outcomes with explicit unfinished URL reasons.

Validation: typecheck, lint, all 40 backend tests, and production build passed. Controlled timing/transport fixtures exercised cancellation without external services. F6 discovery prefetch/checkpoint limitations remain deferred.

## Batch 4 — F9–F12

All four browser regressions failed before their fixes: invisible logout failure, Add Client retry issuing no second POST, empty displayed applied search, and malformed date unmounting the app. All now pass on desktop and mobile. Typecheck, lint, 40 backend tests, production build and all 28 browser tests passed. No API contracts or database contents were changed.

## Batch 5 — F13–F15

Regressions first rejected Vite development HTML, incompatible engine ranges, vulnerable lint dependency, and runtime TypeScript tooling. Production browser builds now explicitly use NODE_ENV=production and Vite preview serves the built artifact. CI runs the same browser command on Node 22.19.0 and 24. Declared engines are ^22.19.0 || >=24.0.0; the engine test checks every locked package and passed on the actual 22.19.0 minimum and local Node 24.13.0.

A scoped typescript-estree minimatch override to 11.0.1 fixes the seven development advisories without changing application dependencies. Fresh npm audit reports zero advisories. The application image is a fresh Node stage with production dependencies and compiled application sources; migration tooling uses its own explicit target. The first prune-only attempt correctly failed the runtime regression because Prisma's optional TypeScript peer remained; omitting optional dependencies too removes it. Native Argon2, generated Prisma client and Undici still load successfully. CI checks actual runtime contents and Nginx configuration.

Validation: typecheck, lint, 40 backend tests, 30 desktop/mobile tests, two delivery tests, runtime-image regression, and production builds passed. Frontend JS is 327.03 kB (99.63 kB gzip), not the historical development-bundle measurement. Final clean-clone/live/benchmark verification follows below.

## Final verification and delivery

A new shallow clone at 79044bf passed locked installation, setup, Prisma generation, Compose startup/migration, typecheck, lint, 40 PostgreSQL backend tests, 30 production desktop/mobile browser tests, two delivery checks, actual runtime-image checks, and Nginx configuration validation. Standalone live acceptance analyzed 15 ordered real posts on each site. The clean seed twice produced stable identities and 54,750 rank values over 150 actual associations, matching standalone acceptance selections exactly. Docker smoke passed ownership/CSRF/login/logout/encoded-path throttling, production assets, persisted histories, accessibility and overflow checks. The main local app was updated on port 5188 with unchanged page/keyword/rank fingerprints.

The benchmark passed all scenarios with zero errors and 191,625 temporary measurement snapshots. p95 list 14.58 ms, URL search 238.85 ms, keyword search 76.90 ms, history 27.93 ms. Search latency increased versus the historical baseline; it is explicitly disclosed, not presented as a universal performance improvement. Existing listing/search query code was unchanged, and no causal same-data A/B was performed. All values remain below the required 500 ms. Fixtures were removed and seed fingerprints rechecked.

Commits: batch 1 `0e67c7f`; batch 2 `ad30ef8`; batch 3 `848c957`; batch 4 `62ca3f8`; batch 5 `79044bf`. [Current verification](verification.md), [red/green evidence](evidence/sprint-regressions.json), [clean-clone proof](evidence/sprint-clean-clone.json), [live selections](evidence/sprint-live.json), and [benchmark](evidence/sprint-benchmark.json).

All approved F1–F5/F7–F15 improvements are complete. F6 remains deferred; existing historical extraction versions were preserved. Hosted CI has not run. Ready for public repository submission within assignment scope with these limits and measured search increases disclosed. No public publication or external deployment occurred.
