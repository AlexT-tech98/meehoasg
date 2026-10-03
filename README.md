# MEEHOASG Operations Platform

`index.html` is the GitHub Pages entry point for `ops.meehoasg.com`. Since the 04/10/2026 runtime consolidation, the browser loads one frontend runtime (`meehoa-core.css` + `meehoa-core.js`) and calls one canonical API endpoint (`meehoasg-api-core`). Supabase project: `zxnfhshnavbmvdthrmrd`.

> **Production status — GO-LIVE 01/10/2026:** the website is the primary operations interface and **Supabase is the production source of truth**. Production writeback uses **v9.2 FAST** every 1 minute; a full duplicate-ID health audit runs every 15 minutes. The old Apps Script web app / legacy Sheet flow is retained only for rollback and historical reference and must not be used as the primary writer during normal production.

> **Runtime consolidation — 04/10/2026:** the previous v3→v365 frontend/API layering was consolidated. Browser frontend requests were reduced from 18 compatibility CSS/JS requests to 2 core runtime requests; 10 compatibility MutationObserver declarations are multiplexed through 1 native observer. Critical login/bootstrap, Orders, Production, Dashboard, KPI and Materials reads are served directly by `meehoasg-api-core`. Historical versioned assets/functions remain temporarily as rollback references, not as the normal browser route.

## Current production architecture

```text
[Nhân viên shop]
Website — ops.meehoasg.com
    │
    ├── meehoa-core.css
    └── meehoa-core.js
    │
    ▼
meehoasg-api-core (core2)
    │
    ├── direct hot paths:
    │     login/bootstrap
    │     Orders / Production
    │     Dashboard / KPI
    │     Materials AI
    │
    └── uncommon compatibility/write routes
          └── at most one direct fallback → stable meehoasg-api
    │
    ▼
Supabase  ← SOURCE OF TRUTH
    │
    ├────────► Google Order Sheet (A:O)
    │              identity = Order ID in column O
    │
    └────────► MEE_OPS_DATABASE / MIG_ORDER_META_V6
```

There is no normal browser path through `meehoasg-api-v36 → v361 → v362 → v363 → v364 → v365`. Those historical functions are retained for rollback/audit only.

Production rules:
- Website/Supabase is authoritative for new and edited production orders.
- Google Sheets are synchronized downstream for operations, reporting, fallback and audit.
- `source_row` / `source_sheet` are location caches only; they never identify a row for overwrite.
- Automatic legacy Sheet/web-app → Supabase writers are stopped in production mode.
- Payment Check is operationally sourced from Supabase `settlement_requests`; legacy settlement sync is retained only for rollback/history.
- SALE users can **see all orders immediately**, but may edit only orders assigned to their own canonical account.
- Sale identity in Dashboard/KPI comes from `app_users.username + app_users.display_name`, so aliases such as `cmui/C Mụi`, `huynhxuyen/Huỳnh Xuyến`, `huynhlan/Huỳnh Lan`, `pu/Pu` are grouped as one person.
- KPI revenue is recognized only after `settled=true`.
- Dashboard exposes both unsettled and settled revenue so operations remain visible before settlement.

## Current business and UI behavior

### Revenue / KPI

- Dashboard keeps separate `settledRevenue` and `unsettledRevenue` values, plus the operational gross total.
- Base CMS is calculated from settled revenue.
- Dashboard exposes `salesDaily` grouped by order date + canonical salesperson.
- KPI revenue, big-order count, commission-rate eligibility, commission and bonus use **settled orders only**.
- Canonical salesperson identity is resolved from `app_users`, not raw free-text `orders.sale`.

### AI Materials

Canonical hot path: `supabase/functions/meehoasg-api-core/index.js`.

- AI normalizes spelling/aliases without intentionally removing purchase-relevant variants.
- Examples include `Ly`, `Ly kép`, `Ly hồng`, `Ly tím pastel`, `Ly xanh mint`, `Ly xanh nhuộm`, `Ly sơn xanh`, `Hồng Ecuador`, `Chiết xạ`.
- One order may contribute to multiple flower groups.
- Counts are **orders containing the flower type**, not stem counts.
- Uncertain / insufficient descriptions are returned in `reviewOrders` instead of being guessed.
- If Gemini is unavailable/unconfigured, an explicit local fallback handles known flower patterns instead of turning every order into review.
- Clicking a material group opens the related-order drawer.

### Orders / Payment / UI shell

- SALE read scope = all orders; edit scope = own orders only.
- Create/edit order supports multiline content fields, formatted money inputs, card quantity (`10.000đ × quantity`) and removable previews for existing/new/pasted images.
- Copy-order output intentionally excludes Order ID.
- Payment Check keeps card-grid display, select-all and bulk review behavior.
- Full-paid production-card copy is `Bankful full hoa`; customer-facing full flower payment copy remains `Đã thu đủ tiền hoa` where applicable.
- Modal/drawer/lightbox surfaces retain close controls and Escape handling.
- Desktop uses a compact left rail; mobile keeps a responsive drawer/hamburger.
- Shortcut/PWA has an in-app reload control that refreshes the shell without requiring the user to kill the app from multitasking.
- Main pages use one vertical page-scroll owner; drawer/modal surfaces scroll locally only when intentional.
- The actual `Đang mở Meehoa Ops…` splash carries the floral/cat/dog illustration; login retains the prior production styling.

## Frontend runtime consolidation

Canonical runtime:
- `assets/meehoa-core.css`
- `assets/meehoa-core.js`
- builder: `scripts/build-runtime.cjs`
- metrics: `runtime-metrics.json`

Current measured build contract:
- separate frontend CSS/JS requests before: **18**
- browser runtime requests after: **2**
- compatibility MutationObserver declarations: **10**
- native MutationObserver instances after multiplexer: **1**
- dead historical request to missing `meehoa-v361.css`: removed

Historical version files remain as deterministic build inputs and rollback references. They are not loaded individually by production `index.html`.

## API consolidation

Canonical Edge Function:
- `supabase/functions/meehoasg-api-core/index.js`
- deployed function: `meehoasg-api-core`
- build marker: `2026.10.04-core2`
- JWT verification: enabled

Direct core hot paths:
- `loginAndBootstrap`
- `getCurrentUserAndBootstrap`
- `getProductionOrders`
- `getOrders`
- `getDashboardSummary`
- `getKpi`
- `getFlowerInventory`

Remaining uncommon compatibility/write calls may use one direct fallback to stable `meehoasg-api`. Core must never proxy through historical generation endpoints (`v36/v361/v362/v363/v364/v365`).

Full consolidation record: `docs/CONSOLIDATION_2026-10-03.md`.

## Production sync versions

### v9.1 SAFE — cutover gate

Source: `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.1.gs`

Key functions:
- `preflightProductionV91()` — read-only duplicate/metadata audit.
- `installProductionCutoverV91()` — enables `MEE_SYNC_MODE=PRODUCTION` only after a clean preflight.
- `syncProductionV91()` — safe Order-ID writeback, retained as the cutover baseline.
- `rollbackToParallelV91()` — controlled rollback to legacy triggers when intentionally needed.

Safety guarantees:
- Order ID in column O is the only row identity.
- Cutover is blocked if an Order ID is duplicated in order tabs or metadata.
- `source_row` is never used to choose a row to overwrite.
- Failed/incomplete writeback batches keep the previous cursor for retry.

### v9.2 FAST — active production writer

Source: `supabase/functions/meehoasg-ingest/apps-script-production-sync-v9.2-fast.gs`

v9.2 is the **active production trigger**:
- `syncProductionV92()` every 1 minute.
- `auditProductionV92Health()` every 15 minutes.

Performance change from v9.1:
- checks the Supabase delta **before** scanning legacy Sheets;
- if `delta = 0`, exits immediately without scanning ~7k Order IDs;
- when there are changes, validates only the changed Order IDs with `TextFinder`;
- a separate full duplicate health audit runs every 15 minutes.

This removes the execution overlap observed in v9.1 while preserving Order-ID safety.

## Data-integrity repair completed before go-live

Historical duplicate-ID repair scripts are kept because they provide an audit trail:
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-id-audit-v1.gs`
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-repair-v2.1.gs`

Final repair result on 01/10/2026:
- `7,233` rows with Order ID;
- `7,233` unique Order IDs;
- duplicate Order IDs: `0`;
- duplicate metadata IDs: `0`;
- `68` shadowed real orders recovered with new unique IDs;
- `85` artifact/empty-row IDs cleared without deleting real order data;
- `1` exact duplicate order row cleared after backup;
- `1` stale duplicate metadata row cleared;
- legacy Supabase synthetic `*-DUP-*` artifacts removed: `68`;
- Supabase backup table retained: `orders_dup_artifact_backup_20261001` (`68` rows);
- Google Sheets repair backup retained: `BK_DUP_REPAIR_V2_20261001_150550`.

Do **not** rerun the duplicate repair on current production data unless performing a deliberate recovery from the recorded backup state.

## Go-live acceptance evidence

Initial production acceptance used order `MEE-133EA255B4234859`:

```text
Website edit
  → Supabase note = GO-LIVE TEST 0110
  → v9.2 fetched=1, inserted=0, updated=1, moved=0, meta=1
  → Google Sheet row 548 updated to the same note
```

Observed end-to-end propagation was under one trigger interval (~1 minute), verifying:

```text
Website → Supabase → v9.2 FAST → Google Sheet + MIG_ORDER_META_V6
```

## Payment Check after cutover

Supabase `settlement_requests` is the operational source for Payment Check. The website creates/reviews Payment Checks directly in Supabase. The legacy `MIG_SETTLEMENT_V6 → Supabase` delta v8 remains only for rollback/history and is not an active production writer after cutover.

At go-live verification, there were no `APPROVED` settlement requests whose corresponding order remained unsettled.

## Rollback policy

Normal production must **not** mix legacy writers with the Supabase-authoritative writer.

For a data-flow rollback:
1. stop v9.2 production triggers;
2. use `rollbackToParallelV91()`;
3. verify trigger state before allowing the old app/Sheet to write again;
4. reconcile changes made during production mode before a future recutover.

For a **frontend/API runtime rollback**, revert the consolidation merge commit while leaving v9.2 production data flow untouched. Historical API functions and source assets are intentionally retained during the stabilization window.

Do not manually enable `syncDelta` or settlement legacy triggers while `MEE_SYNC_MODE=PRODUCTION`.

## Security & storage

The API validates existing usernames and password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's public anon credential carries no database privileges. Service-role credentials remain in Edge Function environments. Application tables use RLS and uploaded order images / settlement bills are private objects returned to authenticated users through time-limited signed URLs.

`meehoasg-api-core` keeps JWT verification enabled and performs direct session/role validation for its protected hot paths.

## Regression suite

GitHub Actions runs `node --test tests/*.test.cjs` on pushes and pull requests to `main`. The workflow also rebuilds deterministic core runtime assets before tests.

Coverage includes:
- consolidated frontend request count and core-asset ordering;
- shared MutationObserver contract;
- canonical API core and no historical API chaining;
- direct login/bootstrap and production/read hot paths;
- SALE read-all/edit-own permission behavior;
- Payment/debt and Payment Check behavior;
- card quantity and image-retention behavior;
- KPI canonical Sale mapping and settled-only revenue;
- split Dashboard revenue;
- AI Materials + review/local fallback;
- mobile navigation, thumbnails, drawer, form, search and single-scroll regressions;
- production cutover / Supabase source-of-truth invariants;
- v9.1 duplicate-ID gate;
- v9.2 delta-first fast path and health-audit split;
- Order-ID writeback identity;
- month-rollover protection;
- bounded/paginated Supabase writeback feed.

## Project structure

- `index.html` / `html`: production shell/base UI.
- `assets/meehoa-core.css`, `assets/meehoa-core.js`: canonical browser runtime.
- `assets/meehoa-v*`, `meehoa-prod-fix.css`, `meehoa-scroll-contract.css`: historical/build-input compatibility sources retained for rollback and deterministic core generation.
- `scripts/build-runtime.cjs`: consolidated frontend builder.
- `scripts/flatten-core-bootstrap.cjs`: core API hot-path consolidation helper.
- `runtime-metrics.json`: deterministic runtime metrics.
- `supabase/functions/meehoasg-api-core/`: canonical production browser API.
- `supabase/functions/meehoasg-api/`: stable legacy API used only as direct compatibility fallback for routes not yet in core.
- `supabase/functions/meehoasg-api-v36*`: historical API generations retained for rollback/audit; not the production browser route.
- `supabase/functions/meehoasg-ingest/`: ingest, historical sync, cutover, audit and repair scripts.
- `supabase/functions/meehoasg-writeback-feed/`: production changed-order feed for Apps Script.
- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.1.gs`: safe cutover/rollback baseline.
- `supabase/functions/meehoasg-ingest/apps-script-production-sync-v9.2-fast.gs`: active production writer.
- `docs/PRODUCTION_GO_LIVE_2026-10-01.md`: data-flow go-live record.
- `docs/CONSOLIDATION_2026-10-03.md`: frontend/API consolidation record.
- `tests/`: regression contracts.
