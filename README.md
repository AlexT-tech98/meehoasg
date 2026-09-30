# MEEHOASG Operations Platform

`index.html` is the GitHub Pages entry point for `ops.meehoasg.com`. The identical `html` file is retained as an editable copy. Both call the `meehoasg-api` Supabase Edge Function in project `zxnfhshnavbmvdthrmrd`.

> **Cutover status — 30/09/2026:** production cutover package v9 is prepared and regression CI is green. The new Supabase → Sheet writeback feed is deployed. The final switch is intentionally gated by one Apps Script action: add `apps-script-production-cutover-v9.gs`, run `installProductionCutoverV9()` once, then run one manual `syncProductionV9()` acceptance pass. Until that action is completed, the old production sync remains in effect.

## Target production architecture

```text
[Nhân viên shop]
Website mới
    │
    ▼
Supabase  ← source of truth
    │
    ├────────► Google Order Sheet
    │
    └────────► MEE_OPS_DATABASE / MIG_ORDER_META_V6
```

Production v9 deliberately stops automatic legacy → Supabase writers during cutover. This prevents an older Sheet/web-app value from overwriting a newer website edit.

## Production cutover v9

Source:
- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.gs`
- `supabase/functions/meehoasg-writeback-feed/index.js`

`installProductionCutoverV9()`:
- verifies the Order Sheet and MEE_OPS_DATABASE are reachable;
- sets `MEE_SYNC_MODE=PRODUCTION`;
- removes recurring `syncDelta`, legacy settlement-delta and prior production triggers;
- installs `syncProductionV9()` every minute.

`syncProductionV9()`:
- reads only orders changed in a bounded Supabase time window;
- pages safely through the writeback feed;
- identifies rows by Order ID in column O, never by `source_row`;
- updates existing rows, appends new rows and moves orders when their month changes;
- writes auxiliary order data to `MIG_ORDER_META_V6`;
- updates `source_sheet/source_row` as location cache only;
- automatically creates a missing monthly tab such as `Tháng 10/2026` with the standard A:O header.

`rollbackToParallelV9()` is the controlled rollback path if the shop intentionally returns to the old app during acceptance.

## Payment Check after cutover

Supabase `settlement_requests` becomes the operational source for Payment Check. The website creates/reviews Payment Checks directly in Supabase. Production v9 stops the legacy `MIG_SETTLEMENT_V6 → Supabase` recurring trigger during cutover so old settlement state cannot overwrite new website state.

The existing legacy settlement delta v8 remains in the repository for rollback/history, not as an active production writer after cutover.

## Data-integrity rules

- `orders.id` / Sheet column O is the identity key.
- `source_row` is cache only and must never select a row for overwrite.
- A changed order date may move the order between monthly tabs.
- Supabase writes must reach both the Order Sheet and `MIG_ORDER_META_V6` before the writeback cursor advances.
- Failed/incomplete batches keep the previous cursor so the next run can retry.

## Security & storage

The API validates existing usernames and SHA-256 password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's public anon credential carries no database privileges. Service-role credentials remain in Edge Function environments. Application tables use RLS and uploaded order images / settlement bills are private objects returned to authenticated users through time-limited signed URLs.

## Regression suite

GitHub Actions runs `node --test tests/*.test.cjs` on pushes and pull requests to `main`.

Coverage includes:
- payment/debt calculations;
- duplicate Payment Check grouping and review;
- legacy time normalization boundary;
- KPI alias handling;
- mobile navigation, thumbnails, drawer, form and search regressions;
- production cutover syntax and source-of-truth invariants;
- Order-ID writeback identity;
- month-rollover protection;
- bounded/paginated Supabase writeback feed.

## Project structure

- `index.html` / `html`: production UI.
- `assets/`: UI CSS/JS layers and production fixes.
- `supabase/functions/meehoasg-api/`: main application API.
- `supabase/functions/meehoasg-ingest/`: legacy/order ingest and Sheet-position recording.
- `supabase/functions/meehoasg-writeback-feed/`: production changed-order feed for Apps Script.
- `supabase/functions/meehoasg-ingest/apps-script-sync.gs`: parallel/legacy v6 sync kept for rollback.
- `supabase/functions/meehoasg-ingest/apps-script-settlement-delta-v8.gs`: legacy settlement delta kept for rollback/history.
- `supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.gs`: production cutover writer.
- `tests/`: regression contracts.
