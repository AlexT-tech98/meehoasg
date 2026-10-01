# MEEHOASG Operations Platform

`index.html` is the GitHub Pages entry point for `ops.meehoasg.com`. The app calls the `meehoasg-api` Supabase Edge Function in project `zxnfhshnavbmvdthrmrd`.

> **Production status — GO-LIVE 01/10/2026:** the new website is the primary operations interface and **Supabase is the production source of truth**. Production writeback is running with **v9.2 FAST** every 1 minute; a full duplicate-ID health audit runs every 15 minutes. The old Apps Script web app / legacy Sheet flow is retained only for rollback and historical reference and must not be used as the primary writer during normal production.

## Current production architecture

```text
[Nhân viên shop]
Website mới (ops.meehoasg.com)
    │
    ▼
Supabase  ← SOURCE OF TRUTH
    │
    ├────────► Google Order Sheet (A:O)
    │              identity = Order ID in column O
    │
    └────────► MEE_OPS_DATABASE / MIG_ORDER_META_V6
```

Production rules:
- Website/Supabase is authoritative for new and edited production orders.
- Google Sheets are synchronized downstream for operations, reporting, fallback, and audit.
- `source_row` / `source_sheet` are location caches only; they never identify a row for overwrite.
- Automatic legacy Sheet/web-app → Supabase writers are stopped in production mode.
- Payment Check is operationally sourced from Supabase `settlement_requests`; legacy settlement sync is retained only for rollback/history.

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

Historical duplicate-ID repair scripts are kept in the repository because they explain the production migration and provide an audit trail:
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

Final acceptance test used order `MEE-133EA255B4234859`:

```text
Website edit
  → Supabase note = GO-LIVE TEST 0110
  → v9.2 fetched=1, inserted=0, updated=1, moved=0, meta=1
  → Google Sheet row 548 updated to the same note
```

Observed end-to-end propagation was under one trigger interval (~1 minute). This verified the intended production path:

```text
Website → Supabase → v9.2 FAST → Google Sheet + MIG_ORDER_META_V6
```

## Payment Check after cutover

Supabase `settlement_requests` is the operational source for Payment Check. The website creates/reviews Payment Checks directly in Supabase. The legacy `MIG_SETTLEMENT_V6 → Supabase` delta v8 remains in the repository only for rollback/history and is not an active production writer after cutover.

At go-live verification, there were no `APPROVED` settlement requests whose corresponding order remained unsettled.

## Rollback policy

Normal production must **not** mix legacy writers with the Supabase-authoritative writer.

If a deliberate rollback is required:
1. stop v9.2 production triggers;
2. use the v9.1 rollback path (`rollbackToParallelV91()`);
3. verify trigger state before allowing the old app/Sheet to write again;
4. reconcile changes made during production mode before a future recutover.

Do not manually enable `syncDelta` or settlement legacy triggers while `MEE_SYNC_MODE=PRODUCTION`.

## Security & storage

The API validates existing usernames and password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's public anon credential carries no database privileges. Service-role credentials remain in Edge Function environments. Application tables use RLS and uploaded order images / settlement bills are private objects returned to authenticated users through time-limited signed URLs.

## Regression suite

GitHub Actions runs `node --test tests/*.test.cjs` on pushes and pull requests to `main`.

Coverage includes:
- payment/debt calculations;
- duplicate Payment Check grouping and review;
- legacy time normalization boundary;
- KPI alias handling;
- mobile navigation, thumbnails, drawer, form and search regressions;
- production cutover / Supabase source-of-truth invariants;
- v9.1 duplicate-ID cutover gate;
- v9.2 delta-first fast path and health-audit split;
- Order-ID writeback identity;
- month-rollover protection;
- bounded/paginated Supabase writeback feed.

## Project structure

- `index.html` / `html`: production UI.
- `assets/`: UI CSS/JS layers and production fixes.
- `supabase/functions/meehoasg-api/`: main application API.
- `supabase/functions/meehoasg-ingest/`: ingest, historical sync, cutover, audit and repair scripts.
- `supabase/functions/meehoasg-writeback-feed/`: production changed-order feed for Apps Script.
- `supabase/functions/meehoasg-ingest/apps-script-sync.gs`: legacy v6 sync retained for rollback/history.
- `supabase/functions/meehoasg-ingest/apps-script-settlement-delta-v8.gs`: legacy settlement delta retained for rollback/history.
- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.gs`: original v9 cutover baseline (historical).
- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.1.gs`: safe cutover gate and rollback baseline.
- `supabase/functions/meehoasg-ingest/apps-script-production-sync-v9.2-fast.gs`: active production writer.
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-id-audit-v1.gs`: historical duplicate audit.
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-repair-v2.1.gs`: historical repair used before go-live.
- `docs/PRODUCTION_GO_LIVE_2026-10-01.md`: cutover record and operational state.
- `tests/`: regression contracts.
