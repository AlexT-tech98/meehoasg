# PR #39 acceptance and release gates

Status: **NO-GO pending live Apps Script provenance, production recovery readiness and exact-head CI**. This document does not authorize production writes or deployment. All work stays in PR #39. No paid cloud staging is required for the reproducible checks below.

Issue #36 has 13 technical checks for 12 reports. The local technical acceptance below is distinct from deployment approval and post-deployment verification.

## Technical acceptance ledger

Real isolated PostgreSQL17.6, PostgREST14.3, Storage1.35.3 and candidate Deno2.5.6 APIs serve Chromium at 1440/390 widths for ADMIN/SALE/THO_OPS. API responses are not mocked. All data/accounts/proofs are synthetic. CI rebuilds empty volumes and uploads only `artifacts/staging-evidence/`.

| #36 | Technical result | Reproducible evidence |
|---|---|---|
| 1 Payment labels | PASS local | API-created flower-only and Full Paid orders rendered in list/detail at both widths; accessory badge geometry cannot cover finance; flower-only 500,000 + accessories125,000 retains125,000 debt |
| 2 Desktop Dashboard parity | PASS local | Authorized Sale report visible at both widths; SQL/API order and revenue reconciliation |
| 3 Eligible debts and Tiên scope | PASS local | Delivered, unverified, debt>0 fixtures; active-role view/submit and inactive/anonymous denial; owner-approved all-shop scope |
| 4 P50/P95 and calls | PASS local budgets | 30 samples each of5 APIs,20k scale search;10 fresh clients each of6 role/width combinations; one bootstrap, no Admin hourly order refetch, zero warm revisit calls |
| 5 Canonical CSS | PASS local | Reproducible generated assets; screenshots across Dashboard/orders/debt/materials/production; canonical CSS ownership tests |
| 6 Global and optional date search | PASS local | Vietnamese normalization,240 global vs40 date+keyword; actual calendar apply; stale suggestion overlay hidden on Orders; bounded distinct pages; SQL anon denial;20k scale |
| 7 Selection only | PASS local | Checkbox issues no mutation; explicit bulk action changes chosen seed only, then restores QA seed status |
| 8 Settlement permissions | PASS local + owner approved | Cross-Sale submit allowed, edit/approval denied; THO_OPS submits actual uploaded bill; ADMIN approval only; see approved policy |
| 9 Multi-day flowers | PASS local |240 distinct orders;120 per canonical variety; actual multiday Tulip drawer120 unique IDs |
| 10 Per-Sale counts | PASS local | Dashboard/API per-Sale counts and gross revenue match SQL |
| 11 Banner quantity | PASS local | Create/edit ×3, validation, legacy fallback1, financial guards, Full Paid invalidation, idempotency; feed/ingest quantity and Apps Script26th metadata column VM test |
| 12 Sticky navigation | PASS local Chromium | Actual scroll geometry after drawers/overlays on six role/width combinations; device Safari remains unmeasured |
| 13 Blank new date | PASS local | New date blank/required; rejected submission writes no order; edit retains persisted date |

Commands: `npm test`, `npm run build`, `node scripts/staging-acceptance.cjs`, `node scripts/staging-browser.cjs`, `node scripts/staging-benchmark.cjs`. CI also runs independent PostgreSQL16 transaction tests and synthetic-browser regression. Local tests are not claims about production customer outcomes, internet latency, managed Edge runtime, Safari hardware or provider Egress billing.

## Performance scope

Local benchmark after stored normalized search key:20k global search P50 **96.55ms**, P95 **217.72ms**,30 samples. Date-filtered orders P95 **72.94ms**, Dashboard **97.11ms**, debt **33.26ms**, materials **31.13ms**. Budget: small APIs1s,20k search3s, cold client5s, warm module500ms. `benchmark.json` records all samples/groups, response sizes and request counts. Cold means fresh browser/session/cache; database and Deno stay warm. Deployment smoke must measure public-network latency separately.

Search now makes one bounded RPC and signs returned-page media only, including date mode. A stored normalized key avoids repeatedly normalizing20k strings. New date/time/id index supports normal date pages; broad substring count still scans matches. No claim of constant-time search at arbitrary scale.

## Release package and baseline

`node scripts/release-manifest.cjs` and `node scripts/build-release.cjs` require a clean tracked tree. CI publishes exact-commit hashes, deterministic tar.gz, per-file manifest, five ordered additive migrations, deployment/rollback docs and compatible fallback. No passwords, runtime config, raw database backups or customer data belong in release artifacts.

[Live backend baseline](validation/release-39-backend-baseline.json) records source hashes and read-only versions: core7, legacy API15, order-actions3, ingest10, writeback-feed4, settlement-ingest3. Shared operations differs, so order-actions must also be rebundled/deployed even if its entrypoint matches. Settlement-ingest matches. Frontend baseline matches main; candidate intentionally differs before deployment.

Production's historical migration ledger differs from reconstructed repository history. Apply only the five reviewed deltas in `scripts/release-migrations.json`, recording receipts/version mapping. **Do not blindly replay all historical repository migrations with db push.** New versions were generated uniquely with Supabase CLI; previous duplicate short IDs were never applied in production.

Apps Script repository source is v9.4 metadata-compatible, retaining v9.2 trigger handler names and first25 metadata columns, appending banner quantity26. Existing data flow stays website-first. The active Apps Script project/source/version/triggers remain **UNVERIFIED**: connected Drive search returned no script project; no Apps Script execution credentials are available. Repository VM tests cannot prove which script is active.

## Recovery and remaining gates

`staging-compatible-fallback.cjs` compares previous green core `52718b2` against upgraded QA schema and actual multi-banner/Full Paid fixtures. `staging-restore.cjs` restores real pg_dump plus independent Storage volume/API, comparing database hashes/finance totals and signed-image bytes. `rollback-rehearsal.cjs` also checks pre/post-release fixture snapshots. See [rollback](release-39-rollback.md).

Before READY TO DEPLOY: retain final exact-head green CI/artifact links; obtain live Apps Script source/version inventory and approve its v9.4 update sequence; confirm production backup availability/recovery point and deployment/rollback owner. Production backup availability is distinct from a successful local restore. No paid staging is intrinsically required. Missing provenance/recovery readiness is not resolved by a green local test.

After authorized deployment: record frontend/function/script hashes/versions, apply read-only reconciliation and approved isolated smoke checks, observe API failures and financial totals; reopen writers only after owner sign-off. No merge, production deployment or customer-data mutation has been performed by this validation.

Owner instruction on16 October2026: **“Bỏ qua phần trigger, xử lý sau.”** Trigger inventory/acceptance is explicitly deferred, not a failed test or a claim of verification. This deferral does not establish the live Apps Script source/version or authorize changing production triggers.

## Post-deployment owner correction

The owner's subsequent instruction restricts debt to the assigned Sale and settlement submission to that owner only, including THO_OPS accounts such as Tiên. This supersedes earlier all-shop eligibility statements in this ledger. ADMIN retains shop-wide review and approval, but cannot submit on another owner's behalf. Cross-account denial is covered through actual SQL mutations, pre-upload API rejection, core reader identity tests, and role/viewport E2E. See `20261016123513_settlement_owner_scope.sql` and the superseding policy record. No customer amounts or historical requests are rewritten.

## Delivery-order regression correction

The owner reported that late delivery times unexpectedly appeared first. Pre-PR39 `fastOrders` used ascending delivery date/time; the bounded page RPC introduced descending ordering outside the requested scope. `20261016130221_restore_order_delivery_sort.sql` restores ascending date, time and deterministic ID ties for both bounded and compatibility search RPCs, including explicit JSON aggregation order. It changes no order rows, permissions, UI layout or filters. Tests cover07:30 before19:00, multiple dates, equal-time ties, global/date keyword search and disjoint pages; real API and browser acceptance assert the restored order.

## Unsettled-order debt membership clarification

The debt list now tracks unfinished settlement, not only positive balances on delivered orders: every assigned order not settled and not Full Paid remains visible in the chosen date range. UI incremental reconciliation applies the same rule; zero-balance/not-delivered notes explain why the item remains. Tests cover a14-order cohort with4 completed and10 unsettled (including5 zero-balance and3 not-delivered), pending requests remaining visible, Full Paid exclusion, pre-upload foreign denial and owner/Admin settlement of a zero-balance order. Delivery ordering, date filters, owner permissions, KPI calculation and monetary formulas are unchanged. No customer rows are rewritten.
