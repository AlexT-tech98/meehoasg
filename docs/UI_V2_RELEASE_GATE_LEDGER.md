# MEEHOA UI V2 — release-first operational gate ledger (2026-10-18)

**Decision:** phased UI V2 release permitted only **after** the operational gates; strictly cosmetic CSS debt can follow in a separate PR. This ledger does not authorize a merge, production deployment, database migration, or customer-data mutation. Consult `UI_V2_PHASED_RELEASE_HANDOFF.md`, `UI_V2_IMPLEMENTATION_CONTRACT.md`, and `UI_V2_CLEAN_SOURCE_AUDIT.md`.

## Verified production reference — READ-ONLY snapshot

The connected Supabase project `zxnfhshnavbmvdthrmrd` was **ACTIVE_HEALTHY**, PostgreSQL **17.6**, on 2026-10-18. Independent SQL SELECT probes found:

- `orders_status_check` admits **three states only**: `Chờ bó`, `Đã bó`, `Đã giao`. Live RPC `public.mee_ops_mutate` likewise contains **neither** `Chờ giao` nor `Chờ lấy`. Live function-definition MD5: `141c34812d767c2a1d193553108a2cf9`.
- Status counts at this instant: `Chờ bó 352`, `Đã bó 1004`, `Đã giao 4717` (6,073 total). 2,217 orders marked settled; 161 marked Full Paid. These are time-sensitive inventory/checkpoint counts, **not** a permanent expectation or a production post-deploy reconciliation receipt. No order/customer row was mutated by this inspection.
- Existing migration ledger ends at `20261016130739 restore_order_delivery_sort`. UI V2's `20261018120000_ui_v2_fulfillment_states.sql` **has not been applied**. Never replay PR #39 migration instructions as a shortcut.
- Deployed Edge versions: `meehoasg-api-core v14`, `meehoasg-api v21` (both verify JWT), `meehoasg-order-actions v6` (its own authorization; verifyJwt=false), `meehoasg-ingest v11`, `meehoasg-writeback-feed v5`, `meehoasg-settlement-ingest v3`. Exact live bundle hashes and frontend served hashes still need final capture/retention in the deployment package; historical repo baselines are not live 18 October baselines.
- No verification has been obtained for **current managed production backup/PITR recovery point**, the active Apps Script source/version, an audited compatible rollback artifact, or the named rollout/rollback operator. These cannot be inferred from a local restore passing.

**Implication:** UI V2 is **not frontend-only**. The five-step fulfillment flow requires the reviewed matching **SQL constraint/RPC + API status reader/writer + frontend**, with a pause and explicit verified rollout/rollback sequencing. Deploying just the UI can cause status writes to be rejected or business status drift. PR #39 runbooks are reference material only.

## Concrete pre-release corrections on this branch

1. **Dashboard money parity:** removed `dashboardApplyStats`/`patchDashboardOrder`, which could locally increase commission for unsettled orders and leave settled/Sale/attention data stale. A canonical mutation now invalidates and re-fetches the complete server-owned Dashboard snapshot. Tests `tests/ui-v2-dashboard-finance-reconciliation.test.cjs` and `tests/dashboard-range-functional.test.cjs` cover money/cache invalidation and cross-day hourly buckets.
2. **Shipping/readiness guard:** SQL now rejects changing pickup-versus-delivery when already `Chờ lấy` or `Chờ giao` (`SHIPPING_STATUS_CONFLICT`). Operator must explicitly move back to `Đã bó` before changing the route, then advance to the correct queue. A real local PostgreSQL/API flow is in `scripts/staging-acceptance.cjs`.
3. **Production financial readability:** narrow Kanban cards use a dedicated `.mee-production-finance` layout in the Production stylesheet; amount/debt spans wrap inside card boundaries rather than being at risk of clipped finance cues. The six-combination Chromium browser suite asserts that visible finance spans remain within card bounds.

These changes are candidate code and tests, **not production outcomes**. Any CI pass applies only to its exact SHA.

## CSS classification and visual proof

- The active 1,135 `!important` occurrences are measured historical debt, not individually classified or automatically release-blocking. The Dashboard V2 owner contains zero such declarations. Do not add override tails or parallel observer-based DOM rewriting.
- Retrieved and visually inspected baseline browser screenshot artifact from GitHub Actions [run 39139678239](https://github.com/AlexT-tech98/meehoasg/actions/runs/39139678239), covering 1440px/390px and ADMIN/SALE/THO_OPS on synthetic data. The narrow Production Kanban financial row needed an owner-scoped readability correction as above. Its corrected screenshot/geometry on **final HEAD** requires validation.
- Existing baseline checks include navigation/overlay close, sticky topbar, calendar, image manager, order-detail banners and selection-no-mutation. They do **not** by themselves prove every Debt/Payment/KPI/Materials/Admin control, every touch target or every CSS overlap. Before release, inspect per-module final-HEAD images and role-driven screens for hidden actions, obstructed labels, drawer scrolling, payment/status meanings and mobile access. Log each **actually observed and proven cosmetic** deferred selector/owner/screenshot separately; do not label all 1,135 declarations cosmetic.
- **No CSS defect is declared harmless without a corresponding screenshot/geometry reason.** Post-release Zero Patch Layer cleanup remains an independent follow-up.

## Business parity / test evidence

Earlier exact-head `f5d62e92...` CI [run 39139678239](https://github.com/AlexT-tech98/meehoasg/actions/runs/39139678239) passed three jobs and uploaded synthetic browser, local staging, rollback and release artifacts. This established **local fixture** parity at that historical SHA, not any later code or production success.

At the final SHA, require all three independent CI jobs to pass: regression + real PostgreSQL transaction tests; desktop/mobile by role with final-HEAD screenshots; authenticated local PostgreSQL/PostgREST/Storage/API matrix with status, image, create/edit/save, payment, owner-only settlement, finance, search, Materials fallback, authorization and bulk guards; deterministic release bundles; compatible fallback and restore rehearsal. Regenerate and inspect artifacts for the exact final commit. Only use approved **isolated** records for any production smoke mutation.

## Release/rollback gate — still OPEN

1. **Deployment operator** must capture and retain the *actually served* current frontend HTML/CSS/JS hashes and deployed API/source hashes, actual SQL definition/migration ledger, live writer/script version, and finance/debt baseline. Capture project backup availability, recovery point and usable restore target; name a responsible rollout **and** rollback operator.
2. **Release engineering agent** must confirm the exact SQL/RPC/API source diff and compatibility: new status values cannot be accepted by the old production `orders_status_check`; once any five-stage status is written, an old three-stage frontend/backend is **not** automatically a safe rollback. Prepare and exercise a compatible rollback/forward-fix path that retains valid status, money, image, permission and settlement readers/writers. Never delete legitimate writes or downgrade production constraints by assumption.
3. **QA agent** must finish functional/visual gate-by-effect classification and the final SHA CI plus inspected browser evidence. Fix operational defects inside their declared owner; only proven cosmetic debt may be postponed.
4. **Named operator** only after all above gates: controlled write/ingest pause; reviewed schema/API/frontend sequence; verify served hashes, read-only finance/debt/status reconciliation, authorized isolated smoke, error/performance/sync/egress observation. Stop/rollback for unexplained amount drift, unauthorized operation, hidden control, failed save, status mismatch, absent backup or unidentifiable deployed SHA.

**Current decision: NO-GO, PR stays Draft.** A green CI run alone or 1,135 `!important` declarations alone cannot decide GO/NO-GO. Do not claim DONE until post-deploy operational evidence exists.
