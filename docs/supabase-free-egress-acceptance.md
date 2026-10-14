# MEEHOA: Supabase Free readiness and Egress rollout

Status: NOT DONE. Changes are in draft PR #31 only, not deployed on production.

## Implemented in PR
- Orders API signs image URLs after filtering and paging.
- Debt list does not sign photos; authorized order detail gets pictures on demand.
- Signed URL cache in Edge isolate is bounded to 512 keys, expires at 45 minutes; token expires after 60 minutes.
- Lazy-load order preview, mobile and search images.
- Newly uploaded flower samples are resized to 1600px, JPEG quality 0.78. Receipts preserve 1800px and 0.82.
- No D1, Supabase database or Storage changes, no Cloudflare R2 migration.

## Must pass before deployment
1. Latest-commit CI success.
2. Staging with isolated test users: Orders search/page, Production Kanban/Grid, Debt, Dashboard, image detail, creation/edit, Full Paid, settlement, payment review and rollback.
3. Confirm Debt list issues no signed-photo request; opening detail returns the correct image without exposing private attachments to unauthorized staff.
4. Compare new compressed reference image visually to the original. Confirm receipts stay readable.
5. Confirm failed uploads do not duplicate orders or leave partial finance writes.
6. Preserve a known-good rollback revision and previous Supabase Edge Function release. Production must not be changed before stage acceptance.

## Actual billed Egress is the release criterion
- Record billing usage (cached and uncached where applicable) daily for >= 7 representative days after rollout, plus staff and orders activity.
- Record component usage (Storage, Functions, Database) from Supabase Usage. Logs only diagnose requests; log content-length is not a complete billed usage measurement.
- Goal: conservative projection <= 3 GB billed Egress per 5 GB Free billing cycle, including busy days and >2 GB reserve.
- Verify compatibility with ALL Free limits and unavailable Pro-only features, not just Egress.
- Alerts at 2/3/4 GB require verified billing usage; if inaccessible, risk state = UNKNOWN, not GREEN.
- Downgrade to Free only when evidence and renewal timing are verified. Do not assume automatic downgrade.

## Failure policy
No missing order reference photo, broken receipt, wrong permissions, duplicate order, failed Full Paid or broken production flow is acceptable. Roll back the deployment rather than layering patches.

## Baseline note (2026-10-14)
Supabase unified Storage logs showed around 3,498 signed URL creations versus 324 get_signed reads in a recent diagnostic window. This indicates unnecessary URL generation but does not quantify total billed Egress or prove Free readiness.
