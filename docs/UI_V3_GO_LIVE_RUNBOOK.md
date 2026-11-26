# MEEHOA OPS UI V3 + PERMANENT R2 — PRODUCTION GO-LIVE RUNBOOK

- **Repository:** `https://github.com/AlexT-tech98/meehoasg`
- **Branch / PR:** `feat/ui-v3-orders-drawer` · PR #68
- **Production Frontend:** `https://ops.meehoasg.com` (GitHub Pages from `main`)
- **Supabase Production Project:** `zxnfhshnavbmvdthrmrd` (`ap-northeast-1`, PostgreSQL `17.6`)
- **Google Sheets Sync:** **OFF** (`cron.job` `meehoasg-sheet-sync` `active = false`). **NEVER re-enable Google Sheets Sync before, during, or after Go-Live.**
- **Permanent R2 Reconciliation:** Preserves live Production Permanent Cloudflare R2 (approved 21 Nov 2026) via `supabase/functions/_shared/r2-image-reader.js`, `meehoasg-api-core`, and `meehoasg-api` — no 72-hour trial expiration, no silent fallback to Supabase Storage on Production, full read parity for both `r2://` and legacy `supabase://` references.

---

## 1. Pre-Flight Safety Gate (Stop Before Any Production Change If Any Gate Fails)

1. Confirm PR #68 matches the Agent 1 GO commit, CI (`Meehoa Regression`: `test`, `browser`, `staging`) is 3/3 `SUCCESS`, and `origin/main` has zero out-of-scope commits.
2. Confirm Supabase Production (`zxnfhshnavbmvdthrmrd`) status is `ACTIVE_HEALTHY` and deployment access is active.
3. Verify/create a Production backup (PITR / daily backup checkpoint + pre-deploy SQL snapshot) and tag current Production `origin/main` as `prod-pre-ui-v3-20261126`.
4. Verify compatible rollback artifact `artifacts/rollback/ui-v3-compatible-backend-core/` is built and includes `_shared/r2-image-reader.js`, `meehoasg-api-core`, and `meehoasg-api` with Permanent R2 intact.
5. Record pre-deploy baseline metrics: total orders, active orders, gross/settled/Full Paid revenue, Debt, KPI/commission by Sale, pending/approved `settlement_requests`, status counts.
6. Re-verify the exact **21 legacy deleted orders** (`scripts/legacy-deleted-orders-dry-run.sql`, read-only): must match expected count and IDs (`21/21` confirmed evidence, `0` keyword-only). If changed, pause Step 5 backfill separately for Owner verification.
7. Verify `cmui` (`C Mụi`, `active = true`) exists in `public.app_users` and Google Sheets Sync cron (`meehoasg-sheet-sync`) is `active = false`.
8. Verify zero active conflicting writes during cutover window.

---

## 2. Database Migration (Exact Order — 3 UI V3 Migrations Only)

Execute ONLY these 3 approved UI V3 migrations in order (do **NOT** run `reviewed-schema-delta.sql` from older packages):

1. `supabase/migrations/20261125010000_ui_v3_tag_note_soft_delete_server_filter.sql`
2. `supabase/migrations/20261125020000_ui_v3_rc3_order_source_and_walkin.sql`
3. `supabase/migrations/20261126010000_ui_v3_final_deletion_policy_override.sql`

Verify after each migration:
- Columns exist on `public.orders`: `tag_note_free`, `is_deleted`, `deleted_at`, `deleted_by`, `deleted_by_role`, `deleted_reason`, `deleted_reason_code`, `restored_at`, `restored_by`, `order_source`, `order_type`, `walk_in_payment_method`, `created_by`.
- Table `public.order_deletion_history` exists with RLS enabled (`anon`/`authenticated` denied; `service_role` allowed).
- Functions `public.mee_ops_owner`, `public.mee_search_orders_page`, and `public.mee_ops_mutate` updated cleanly and executable by `service_role`.

---

## 3. Deploy 4 Supabase Edge Functions (Preserve Live Production Auth Config)

Deploy all 4 functions synchronously with `supabase/functions/_shared/*` (including `_shared/r2-image-reader.js`, `_shared/r2-media.js`, `_shared/storage.js`, `_shared/operations.js`, `_shared/vendor/aws4fetch.esm.mjs`):

| Edge Function | `entrypoint_path` | `verify_jwt` (Live Production Parity) | Auth Mechanism |
|---|---|---|---|
| `meehoasg-api-core` | `meehoasg-api-core/index.js` | **`true`** | Supabase JWT + opaque 64-hex `app_sessions` token |
| `meehoasg-api` | `meehoasg-api/index.js` | **`true`** | Supabase JWT + opaque 64-hex `app_sessions` token |
| `meehoasg-delete-order` | `meehoasg-delete-order/index.js` | **`false`** | Opaque 64-hex `app_sessions` token validated in Deno + `mee_ops_mutate` |
| `meehoasg-order-actions` | `meehoasg-order-actions/index.ts` | **`false`** | Opaque 64-hex `app_sessions` token validated in Deno + `mee_ops_mutate` |

Do **NOT** modify `meehoasg-ingest`, `meehoasg-writeback-feed`, `meehoasg-settlement-ingest`, `meehoasg-r2-copy`, R2 secrets/tokens, or Order Bot.

---

## 4. Merge PR #68 & Deploy Frontend (`ops.meehoasg.com`)

1. Mark Draft PR #68 Ready for Review and merge the exact accepted commit into `main`.
2. Wait for GitHub Pages (`pages-build-deployment`) to publish `main` to `https://ops.meehoasg.com`.
3. Verify live `https://ops.meehoasg.com/` and `https://ops.meehoasg.com/html` serve the new UI V3 bundle (`RELEASE='20261126-ui-v3-rc5'`) with no stale cached assets.

---

## 5. Legacy Deleted Orders Backfill (21 Orders)

Run **only after** Steps 2–4 are live and verified:
1. Re-run `scripts/legacy-deleted-orders-dry-run.sql` (read-only) and verify the candidate list still matches the 21 audited orders (`10.371.000đ`). If the list changed, stop this step and verify with the Owner.
2. Execute `scripts/legacy-deleted-orders-backfill.sql` (idempotent; preserves all original columns, `delete_after_sheet_sync`, `legacy_deleted_orders_backup`, and financial history; no physical deletion).
3. Verify:
   - `SELECT count(*) FROM public.orders WHERE is_deleted = true;` = `21`
   - `SELECT count(*) FROM public.order_deletion_history WHERE reason_code = 'LEGACY_MIGRATION';` = `21`
   - Zero double-deduction of revenue/debt/KPI; none of the 21 orders appear on operational screens; all 21 are inspectable and restorable by Admin in Trash.
4. Reversible independently via `scripts/legacy-deleted-orders-rollback.sql` if required.

---

## 6. Post-Deploy Verification (Production)

Verify directly on `https://ops.meehoasg.com` and compare against Pre-Flight metrics:
- Dashboard (revenue, Sale revenue, walk-in breakdown, status counts, alerts)
- Orders (create, edit, search, server status/debt filters, Drawer, `Tag note free`, Order Source)
- Media: Permanent R2 uploads (sample + preview + bill), R2 signed reads AND legacy `supabase://` reads on both `meehoasg-api-core` and `meehoasg-api`
- VietQR Invoice print
- Production & Flower Inventory (walk-in & deleted orders excluded)
- Debt (`deletedWithPaymentAudit` absent; walk-in cash excluded) & Payment Check (deleted orders hidden; `reviewSettlement` rejects deleted orders with `ORDER_DELETED`)
- KPI & Commission (walk-in & deleted orders excluded)
- Walk-in orders (`cmui` default, immediate Dashboard revenue, transfer unverified separation)
- Owner/Admin soft-delete across all payment states + Trash + Admin Restore (zero double counting)
- Order Bot normal operation · Desktop (1440px) & Mobile (390px) UI
- **Confirm Google Sheets Sync remains OFF (`active = false`).**

---

## 7. Compatible Zero-Data-Loss Rollback

Trigger rollback immediately on any unexplained revenue/debt/KPI mismatch, authorization breach, order save/image failure, data loss, or soft-deleted order resurrection:

- **Frontend-only issue:** Revert static files (`index.html`, `html`, `assets/*`) on `main` to `prod-pre-ui-v3-20261126`. Keep UI V3 DB schema + 4 Permanent-R2 Edge Functions intact.
- **Backend issue:** **NEVER** deploy old V2 `meehoasg-api-core` (`40667052` lacks `is_deleted`, `WALK_IN`, and Permanent R2!). Deploy from `artifacts/rollback/ui-v3-compatible-backend-core/` which preserves BOTH UI V3 invariants AND Permanent R2 (`_shared/r2-image-reader.js`, `meehoasg-api-core`, `meehoasg-api`).
- **Database:** **NEVER** overwrite Production DB with an older full snapshot (would lose post-Go-Live orders/payments). Use `scripts/legacy-deleted-orders-rollback.sql` only if reverting Step 5.

---

## 8. Post-Go-Live Monitoring (72h & 7-Day)

- Monitor Edge Function error logs (`query_logs`), page load speed, API latency, and image rendering.
- Track Egress at 72 hours and 7 days using **official Supabase Billing Usage** metrics (confirm new uploads/reads stay on Cloudflare R2 with zero revert to Supabase Storage).
- Do not automatically upgrade or downgrade hosting/database plans.
