# MEEHOA UI V2 — clean-source release gate

Status: CSS source cleanup incomplete. The owner approved a feature-first release path on 2026-10-18: fix operational CSS defects before deployment and defer proven cosmetic debt. See [phased-release handoff](UI_V2_PHASED_RELEASE_HANDOFF.md). Do not mark operational DONE merely because CI passes.

## Measured canonical CSS baseline (2026-10-18)
The frontend CSS build still composes 7 source owners. `!important` declarations in active sources:

| Owner | Baseline declarations |
| --- | ---: |
| meehoa-v3.css | 285 |
| meehoa-v34.css | 169 |
| meehoa-v35.css | 34 |
| meehoa-v361.css (Dashboard V2) | 0 |
| meehoa-v362.css | 3 |
| meehoa-v364.css | 139 |
| meehoa-v365.css | 505 |
| **Total** | **1,135** |

These are measurable override debt, not proof that all declarations conflict. A limit is enforced by `tests/ui-v2-css-debt.test.cjs`, so future commits cannot increase the baseline without explicit review.
Forty-six branding, shipping, loading and page-status declarations were moved from the Production stylesheet to the Shell owner without increasing the total. The owner ceilings and total ceiling now record this transfer.

## Evidence and work to collect
1. Determine the unique owner for each shell/navigation/topbar, Orders/list/drawer, Production, KPI, Debt, Payment and Materials selector and corresponding JS handler. Verify historical implementations are not executed or injected.
2. Replace **operationally significant** overlapping declarations inside the designated owner before release. Record a selector, owner, visual evidence and noncritical rationale for every deferred CSS overlap. Remove obsolete owners/styles only after desktop + mobile visual baseline and role-based browser checks pass. Do not stack last-file overrides or delete rules merely because they use `!important`.
3. Verify the API, SQL RPC, historical orders and status translations for the 5-step Production path. Any transition must remain explicit, authorized and never triggered by checkbox selection.
4. Run unit/regression, authenticated local staging, desktop/mobile browser matrix, bundle reproducibility and rollback rehearsal on the **final SHA**. Preserve finance, settlement, paid orders, stored images and roles.
5. Obtain a controlled production deployment with rollback available and confirm real post-deploy smoke tests plus operational/egress evidence. Production smoke tests cannot be asserted before the operator deploys.

## Current verified limits
Dashboard has one direct renderer and zero `!important` in its designated stylesheet. Legacy Dashboard chart and v361 injection classes have been retired from production CSS. Canonical UI JavaScript now contains zero `MutationObserver` calls: Production, drawer, form, calendar, payment, Materials and shipping/settlement owners invoke explicit render hooks. The generated bundle no longer installs an observer multiplexer. Desktop/mobile synthetic browser acceptance covers six viewport/role combinations, including calendar, mobile menu and image manager lifecycles.

The CSS base still has substantial historic overrides and has not yet been demonstrated clean. This remains a post-release source-cleanup goal for any overlap proven cosmetic; critical overlap and production-readiness checks remain pre-release gates. Authenticated staging is not production operational evidence. Therefore the phased release is **not yet approved for deployment**, and the full Zero Patch Layer goal remains **not passed**.
