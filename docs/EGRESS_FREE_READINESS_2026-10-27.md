# Free plan egress readiness

Baseline and release gates for project `zxnfhshnavbmvdthrmrd`. This document records measured facts; it is not a production deployment.

## Official baseline

- Billing period: 14 October–14 November 2026.
- 27 October: 22.454 GB uncached and 0.256 GB cached egress for the organization and the Meehoa project.
- 26 October: 373.339 MB Storage, 62.829 MB PostgREST and 63.268 MB Functions egress (499.436 MB total).
- 31 October: 23.535 GB uncached and 0.341 GB cached cumulative. Full days after Sheet sync stopped: 28 October ~228 MB (Storage 220.914 MB); 29 October ~286 MB (Storage 274.271 MB); 30 October ~372 MB (Storage 363.781 MB). Storage remains the dominant source and all three days exceed the Free daily pace.
- Free allows 5 GB uncached and 5 GB cached per billing period. Budget a maximum of 140 MB uncached per day to leave headroom below roughly 167 MB/day over 30 days.

## Measured sources and required changes

- `meehoasg-writeback-feed` returned 63.77 MiB in 1,401 calls on 26 October. Its two Apps Script schedules were removed on 27 October by the account owner. Verify calls remain at zero and measure Billing after its hourly refresh.
- Signed `order-images` GET responses totaled 277.36 MiB across 1,041 requests on 26 October; mean 272.8 KiB, P95 551.8 KiB. List and search previews currently download the full original.
- On 30 October, signed image GETs returned 265.91 MiB across 1,092 successful requests; 21 GET 400 responses were also logged. The old feed had zero calls that day. These are production measurements before the preview release.
- Keep originals private for detail viewing. Generate a separate preview at upload, backfill previews for existing images while Pro transformation is available, and render previews in lists/search/production. Do not rely on Supabase's runtime image transformation after switching to Free because the feature requires Pro.
- Gate release on all referenced historical images having previews, no new Storage GET 400, passing CI and a representative multi-account browser check. Preserve originals and order references.
- Evaluate Free from a complete post-release billing cycle, using the official organization totals. Do not change the plan before that evidence exists.

Sources: Supabase organization Usage page and project Storage/Functions logs, 27–31 October 2026; Supabase docs on [egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress) and [image transformations](https://supabase.com/docs/guides/storage/serving/image-transformations).
