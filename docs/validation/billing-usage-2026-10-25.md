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
