# MEEHOASG Production Go-Live — 01/10/2026

## Decision

**Status: PRODUCTION GO-LIVE.**

The new operations website is the primary interface. Supabase is the production source of truth. Google Sheets remain synchronized downstream for operations/reporting and as a fallback/audit surface.

## Active flow

```text
Website (ops.meehoasg.com)
    ↓
Supabase orders / settlement_requests
    ↓
Apps Script v9.2 FAST
    ↓
Google Order Sheet + MIG_ORDER_META_V6
```

Active schedules:
- `syncProductionV92()` — every 1 minute.
- `auditProductionV92Health()` — every 15 minutes.

Legacy automatic writers are disabled in normal production:
- `syncDelta`
- `syncLegacySettlementsDeltaV8`
- `syncLegacySettlementsToSupabase`

## Why v9.2 replaced v9.1 as the active writer

v9.1 correctly enforced Order-ID safety, but it performed a full production-readiness scan before every one-minute sync. With 7,233 Order IDs this caused execution overlap and skipped trigger runs.

v9.2 keeps the same safety model but changes the hot path:
1. query the bounded Supabase delta first;
2. exit immediately when there are no changes;
3. when changed orders exist, validate only those IDs against legacy Sheet/metadata;
4. run a full duplicate health audit separately every 15 minutes.

## Identity invariant

`orders.id` / Sheet column O is the only row identity.

`source_sheet` and `source_row` are cache/location metadata only. They must never be used to choose a row for overwrite.

## Historical duplicate repair

Pre-cutover audit found 154 duplicate Order-ID groups. Forensic classification and repair produced this final state:
- 68 shadowed real orders recovered with new unique IDs;
- 85 artifact/empty-row IDs cleared;
- 1 exact duplicate order row cleared after backup;
- 1 duplicate metadata row cleared, retaining the correct/newer metadata record;
- final order state: 7,233 rows with ID / 7,233 unique IDs / 0 duplicate IDs;
- final metadata duplicate count: 0.

Backups:
- Google Sheets / MEE_OPS_DATABASE: `BK_DUP_REPAIR_V2_20261001_150550`.
- Supabase migration-artifact backup: `orders_dup_artifact_backup_20261001` (68 rows).

The 68 legacy Supabase IDs matching `*-DUP-*` were synthetic migration artifacts, not separate real orders. After verifying that none were referenced by settlement, activity, or KPI records, they were deleted from the live `orders` table and preserved in the backup table above.

## Payment Check state

The operational Payment Check source after cutover is Supabase `settlement_requests`.

Legacy settlement delta v8 was used during parallel migration and remains in source control for rollback/history, but it is not an active production writer.

At go-live verification, approved settlement requests had no corresponding unsettled-order inconsistency.

## Acceptance test

Order: `MEE-133EA255B4234859` (`test đơn`, 30/09/2026).

Action:
- note changed on the new website from `ssss` to `GO-LIVE TEST 0110`.

Verification:
- Supabase stored `GO-LIVE TEST 0110`;
- v9.2 logged `fetched=1, inserted=0, updated=1, moved=0, meta=1`;
- `Tháng 09/2026` row 548 received `GO-LIVE TEST 0110` with the same Order ID;
- propagation completed within the one-minute trigger interval.

Acceptance result: **PASS**.

## Normal operating policy

- Staff create/edit production orders on the new website.
- Do not use the old web app as a parallel production writer.
- Do not manually enable legacy order/settlement triggers while in production mode.
- If Sheet differs from website/Supabase, Supabase is authoritative unless a controlled incident review concludes otherwise.

## Rollback

The rollback baseline is v9.1:
- run `rollbackToParallelV91()` only as an intentional incident response;
- verify production v9.2 triggers are stopped;
- restore legacy writers only through the controlled rollback function;
- reconcile any production-mode changes before recutover.

## Source files

- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.1.gs`
- `supabase/functions/meehoasg-ingest/apps-script-production-sync-v9.2-fast.gs`
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-id-audit-v1.gs`
- `supabase/functions/meehoasg-ingest/apps-script-duplicate-repair-v2.1.gs`
- `supabase/functions/meehoasg-writeback-feed/index.js`
