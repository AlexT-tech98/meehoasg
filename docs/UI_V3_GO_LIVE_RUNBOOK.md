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

## 2. Database Migration (Exact Order — 4 UI V3 Migrations Only)

Execute ONLY these 4 approved UI V3 migrations in order (do **NOT** run `reviewed-schema-delta.sql` from older packages):

1. `supabase/migrations/20261125010000_ui_v3_tag_note_soft_delete_server_filter.sql`
2. `supabase/migrations/20261125020000_ui_v3_rc3_order_source_and_walkin.sql`
3. `supabase/migrations/20261126010000_ui_v3_final_deletion_policy_override.sql`
4. `supabase/migrations/20261126020000_ui_v3_guard_queued_order_trash_compat.sql`

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
- Track Egress at 72 hours and 7 days using **official Supabase Billing Usage** metrics (distinguishing **Cached Egress** vs **Uncached Egress**, confirming new uploads/reads stay on Cloudflare R2 with zero revert to Supabase Storage).
- Do not automatically upgrade or downgrade hosting/database plans.

---

## 9. V3.1 Post Go-Live Stabilization & Optimization Release Runbook

Applies on top of UI V3 Production baseline `f0f9953cc53ab123707d7eef817b3cf3eefea63d` (`feat/ops-v3.1-stabilization`). **Do NOT execute on Production until Owner Go-Live authorization.**

### 9.1 Database Migrations (2 V3.1 Delta Migrations — Total 6 UI V3 / V3.1 Migrations)
1. Verify zero duplicate normalized usernames on `public.app_users` (pre-audited: 18/18 unique).
2. Apply the **2 V3.1 delta migrations** in order (migrations 1–4 of UI V3 are already live on `f0f9953`):
   - `supabase/migrations/20261126030000_ui_v3_1_username_uniqueness.sql` (adds `public.mee_username_norm(text)` and `idx_app_users_username_norm_unique`).
   - `supabase/migrations/20261126040000_ui_v3_1_guard_queued_order_r2_uri_compat.sql` (permits exact 1-to-1 `supabase://` <-> `r2://` media URI switch/rollback on queued-delete orders while keeping all `ORDER_DELETING` protections intact).

### 9.2 Deploy Updated Edge Functions (Preserve Live Auth Config)
- `meehoasg-order-actions` (`verify_jwt = false`): Permanent R2 fail-closed settlement bill uploads (no Supabase fallback on R2 error).
- `meehoasg-api` (`verify_jwt = true`): `saveUser` create/edit separation + duplicate normalized username block (`USERNAME_EXISTS`) + DB `23505` guard.
- `meehoasg-r2-copy` (`verify_jwt = false`, `apikey = SUPABASE_SECRET_KEYS.default`): controlled explicit `keys` batch copy + SHA-256 & R2 GET verification.
- Keep `meehoasg-api-core` (`verify_jwt = true`), `meehoasg-delete-order` (`verify_jwt = false`), R2 secrets/tokens, Order Bot token, and Google Sheets Sync **OFF** (`active = false`) unchanged.

### 9.3 Frontend Deploy (`ops.meehoasg.com`)
- Merge V3.1 PR to `main` and confirm GitHub Pages publishes `RELEASE='20261126-ui-v3-1'`:
  - Drawer: unified `ĐỊA CHỈ GIAO HÀNG` block (2 lines matching Thiệp/Note), compact copy icon replacing `Chạm để copy`, single top copy button `Copy thông tin đơn hàng`.
  - Admin User Modal: explicit create vs edit mode with readonly username in edit mode.

### 9.4 Controlled Production Data Operations (Only After Steps 9.1–9.3 Verified)
1. **Group 1A — Legacy Note -> `tag_note_free` Normalization (Approved `3,619 / 910` Safe Policy):**
   - Re-run read-only `scripts/legacy-note-to-tag-note-free-dry-run.sql` immediately before migrating to reconcile live counts against baseline (`3,619` auto-migrate eligible = `1,521` explicit + `2,098` clean legacy; `910` kept safely at `note` = `789` card/banner + `32` `"Bổ sung sau"` + `23` payment/deposit + `66` ops/mixed; `22` deleted/audit + all post-Go-Live `>= 2026-11-26T07:28:27Z` protected/skipped; `0` manual review required).
   - Run `scripts/legacy-note-to-tag-note-free-backfill.sql` (creates `public.legacy_note_migration_backup`, idempotent).
   - Independent rollback: `scripts/legacy-note-to-tag-note-free-rollback.sql`.
2. **Group 2B — Legacy Bills Migration Across Both Sources (`settlement_requests` + `orders.full_paid_bill_urls`):**
   - Re-run read-only `scripts/legacy-settlement-bills-inventory.sql` and `node scripts/migrate-settlement-bills-to-r2.cjs --dry-run` (audit baseline: `430` `settlement_requests` + `489` `orders.full_paid_bill_urls` = `919` distinct bills, `0` overlap, plus any newly submitted `settlement_requests` bills prior to V3.1 cutover; `0` missing in `storage.objects`).
   - Run `scripts/migrate-settlement-bills-to-r2.cjs --copy --batch-size=20 --report=artifacts/r2-bills-verified.json` then `--verify --batch-size=20` (SHA-256 + R2 GET verification on every object).
   - Run `scripts/legacy-settlement-bills-r2-switch.sql` with verified keys list (creates `public.legacy_settlement_bills_r2_backup` and `public.legacy_full_paid_bills_r2_backup`, switches DB refs in both tables to `r2://meehoasg-website-media/settlement-bills/...`, **keeps Supabase Storage originals intact** until Owner approves separate cleanup).
   - Verify Payment Check and Full Paid Order Drawers display migrated bills cleanly; independent rollback: `scripts/legacy-settlement-bills-r2-rollback.sql`.
3. **Group 2C — Go-Live R2 Test Objects Cleanup (Allow-List Only):**
   - Run `scripts/r2-cleanup-golive-test-objects.cjs` (`--dry-run` first, then `--execute` after Owner confirmation) covering **ONLY** the 6 allow-listed keys (3 currently present in `meehoasg-website-media` from purged `MEE-4C8D65C26A8B4BA1`, 3 already absent from `MEE-3ECAF7FA21984333`), checking `orders`, `settlement_requests`, `order_deletion_history.order_snapshot`, `activity_log.{before_data,after_data}`, and `operation_receipts.result` (distinguishing historical receipts of purged test orders from active references). Never deletes `MEE-4CEA187B770C469B` (`efe981ed-...`, still in Trash) or any customer/website/Order Bot media.

### 9.5 Official Supabase Egress Monitoring (72h & 7-Day)
- Monitor **Supabase Dashboard -> Organization Billing / Usage -> Egress**: track **Cached Egress** vs **Uncached Egress** separately at 72 hours and 7 days post-V3.1.
- Confirm new sample images, Full Paid bills, and settlement bills incur **0** new Supabase Storage uploads/egress, and do not downgrade to Free or change plans without Owner review.
