# Create-order latency correction — 2026-10-16

Production read-only performance_log inspection found five createOrder samples in the preceding 48 hours: client duration 3902–9884 ms, server hourly averages 1301–2385 ms. These are sparse ADMIN-only observations, not a representative production benchmark. Client timing excludes the image preparation before gas(). Network upload, gateway/cold start, and response download remain material unknowns. No production test order or customer assignment was changed.

The candidate removes a redundant orders REST read for a fresh successful SQL receipt (the transaction returns the committed row). Idempotent receipts still reload the current row so later edits/approvals are not overwritten in the UI. Directory loading overlaps this retry read. Image uploads and signed URL creation process bounded batches of three instead of serial image requests. Upload failures wait for every in-flight request before compensation; no upload is discarded after an uncertain SQL result. No SQL, permission, financial, image quality, frontend or Apps Script business rule changes.

For a fresh create with N ordinary images, application-internal REST/storage calls decrease from 7+2N to 6+2N; the browser still sends one create request. Serial upload/sign rounds each decrease from N to ceil(N/3). The mandatory session checks, idempotency lookup and transactional commit are preserved.

Real disposable local PostgreSQL/PostgREST/Storage/API, 12 creates per group, warm processes, tiny PNGs:

| Images | Before P50/P95 ms | After P50/P95 ms |
|---|---|---|
| 0 | 40 / 61 | 37 / 62 |
| 1 | 52 / 80 | 52 / 68 |
| 5 | 137 / 170 | 101 / 138 |

The five-image P50 improves 26%, P95 19% in this environment. Do not project these milliseconds or percentages onto production/mobile. Before/after files are artifacts/staging-evidence/create-perf-{before,after}.json. Reproduce with `node scripts/staging-create-benchmark.cjs <label>` against the explicitly checked local synthetic environment only; this writes synthetic QA orders, never production.

Validation: 39 regression test files pass; 14 real API acceptance scenarios pass. Behavioral concurrency tests verify bounded upload overlap, input image order, waiting for late successes before cleanup, fresh transaction row reuse, retry freshness, and ordered signed URLs. The real API suite verifies storage image retrieval, idempotency, owner-only settlement, Full Paid, debt completeness and delivery sorting.

Rollback: restore the complete three backend function bundles from f5ce1568fc964c6b607dfc0057abdb7a1bdf6b02, including its shared storage module. Keep the current frontend, owner-scope SQL and all-unsettled debt behavior. No database rollback or customer-row edits are required. Preserve all receipts and storage objects.
