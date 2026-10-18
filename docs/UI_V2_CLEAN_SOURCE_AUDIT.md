# MEEHOA UI V2 — clean-source release gate

Status: BLOCKED pending audited replacement and production verification. Do not mark DONE merely because CI passes.

## Measured canonical CSS baseline (2026-10-18)
The frontend CSS build still composes 7 source owners. `!important` declarations in active sources:

| Owner | Baseline declarations |
| --- | ---: |
| meehoa-v3.css | 239 |
| meehoa-v34.css | 169 |
| meehoa-v35.css | 80 |
| meehoa-v361.css (Dashboard V2) | 0 |
| meehoa-v362.css | 3 |
| meehoa-v364.css | 139 |
| meehoa-v365.css | 505 |
| **Total** | **1,135** |

These are measurable override debt, not proof that all declarations conflict. A limit is enforced by `tests/ui-v2-css-debt.test.cjs`, so future commits cannot increase the baseline without explicit review.

## Release-blocking evidence to collect
1. Determine the unique owner for each shell/navigation/topbar, Orders/list/drawer, Production, KPI, Debt, Payment and Materials selector and corresponding JS handler. Verify historical implementations are not executed or injected.
2. Replace overlapping declarations *inside the designated owner*; remove obsolete owners/styles from the runtime build only after desktop + mobile visual baseline and role-based browser checks pass. Do not stack last-file overrides or delete rules merely because they use `!important`.
3. Verify the API, SQL RPC, historical orders and status translations for the 5-step Production path. Any transition must remain explicit, authorized and never triggered by checkbox selection.
4. Run unit/regression, authenticated local staging, desktop/mobile browser matrix, bundle reproducibility and rollback rehearsal on the **final SHA**. Preserve finance, settlement, paid orders, stored images and roles.
5. Obtain a controlled production deployment with rollback available and confirm real post-deploy smoke tests plus operational/egress evidence. Production smoke tests cannot be asserted before the operator deploys.

## Current verified limits
Dashboard has one direct renderer and zero `!important` in its designated stylesheet. Legacy Dashboard chart and v361 injection classes have been retired from production CSS. The rest of the CSS base has substantial historic overrides and has not yet been demonstrated clean. Therefore the zero-patch architectural requirement remains **not passed**, despite passing CI on earlier commits.
