# Supabase Billing Usage baseline — 25 October 2026

Source: Supabase Dashboard, organization `meehoasgg`, Usage, current billing cycle (14 October–14 November 2026), filtered first to project `zxnfhshnavbmvdthrmrd`, then to All projects. Both views showed the same egress totals. Dashboard figures may refresh up to one hour late.

| Metric | Official usage | Pro allowance | Free allowance |
| --- | ---: | ---: | ---: |
| Uncached Egress | 21.484 GB | 250 GB | 5 GB |
| Cached Egress | 0.212 GB | 250 GB | 5 GB |
| Storage Size | 0.379 GB | 100 GB | 1 GB |
| Edge Function Invocations | 28,695 | 2,000,000 | See current pricing |

Official project-filtered Usage URL: <https://supabase.com/dashboard/org/wrrijfopxqixxvovsajd/usage?projectRef=zxnfhshnavbmvdthrmrd>. Organization total: <https://supabase.com/dashboard/org/wrrijfopxqixxvovsajd/usage>.

Free egress limits were verified against [Supabase's current egress documentation](https://supabase.com/docs/guides/platform/manage-your-usage/egress) on the same date. The current cycle already exceeds the Free uncached egress allowance by 16.484 GB. Downgrading now would therefore not meet the Free egress limit. This is a quota assessment only; no plan setting was changed. Reassess using a complete post-release billing cycle and the organization total, since usage is billed across projects.

Read-only logs over the preceding 24 hours showed 295 Storage 400 responses with `InvalidJWT` and `"exp" claim timestamp check failed`. The core API signed the same object more than 150 times in that period for several images. The candidate now caches signed URLs for 45 minutes inside each Edge isolate and coalesces concurrent requests. The frontend no longer substitutes an older signed URL when the API returns a fresh token. These changes are locally tested, not deployed; Billing Usage cannot yet demonstrate their effect.

PostgREST logged repeated `Warp server error: Thread killed by timeout manager`; this has not been attributed to a specific request or verified as resolved. No release or production stability claim follows from this baseline.


## Read-only follow-up — 25 October 2026, approximately 17:10 ICT

- GitHub Actions run [40182896104](https://github.com/AlexT-tech98/meehoasg/actions/runs/40182896104) for the initial PR head `3baf852`: `test`, `staging`, and `browser` succeeded. This does not validate later commits or production.
- Supabase project status: `ACTIVE_HEALTHY` at inspection; this does not establish business-flow acceptance.
- Prior 24-hour Storage logs sampled through the project's read-only unified logs: 7,100 successful Storage `POST` responses (primarily signed URL generation), 1,733 successful `GET` and 301 `GET 400`. Source: `storage_logs` grouped by `res.statusCode` and `req.method`. Counts are logs, not official Billing bytes, and may contain ingestion delay.
- PostgREST emitted the Warp `Thread killed by timeout manager` message repeatedly, including 186 occurrences from 07:00–07:59 UTC on 25 October. This log message alone does **not** prove a failing database query; [PostgREST issue #4799](https://github.com/PostgREST/postgrest/issues/4799) documents normal shutdown paths that produce the same wording. Correlate request IDs, gateway error rates, connection health, and user-visible save failures before assigning root cause.
- Live read-only `pg_stat_activity`: 45 database sessions (11 idle PostgREST, 15 idle Storage; others), one active inspection request, zero waiting locks, `max_connections=60`. This is one snapshot, not peak capacity.
- Live `pg_stat_statements`: `mee_search_orders_page` wrapper approximately 3,077 calls, mean 93.95 ms, max 5,213 ms (cumulative statistics, not last-24h data). This RPC requires ongoing observation, but no individual timeout attribution is proven.
- Candidate follow-up also overlaps independent order-detail lookups and signed-image operations instead of making them serial; validate with its own exact-commit CI before release.

**Release gate unchanged:** no merge or deploy without approval; production mutation acceptance on multiple accounts and post-release official Billing verification remain pending. Do not downgrade based on this cycle.
