# MEEHOASG Production Consolidation — 2026-10-03/04

## Goal
Reduce runtime layering, duplicate observers and API proxy hops without changing production data or business behavior.

## Safety contract
- `main` remains the current production/rollback baseline until the consolidated build is accepted for cutover.
- No production database rewrite is part of this refactor.
- Historical assets/functions remain in the repository/Supabase temporarily as rollback references, but the consolidated browser entrypoint does not load the historical frontend files individually.
- Consolidation work is isolated on `refactor/consolidate-production-core-20261003` / PR #4 until cutover.

## Starting architecture confirmed

### Frontend
The browser previously requested 18 separate compatibility assets (10 CSS + 8 JS), spanning v3 through v365. One referenced CSS asset (`meehoa-v361.css`) did not exist, creating a dead request.

The separate JS generations also instantiated multiple MutationObservers against overlapping UI surfaces.

### API
The previous browser target was `meehoasg-api-v365`, with historical wrappers/fallbacks through v364/v363/v362/v361/v36 before legacy `meehoasg-api`.

## Consolidated architecture implemented on the refactor branch

### Frontend runtime
Canonical browser assets:
- `assets/meehoa-core.css`
- `assets/meehoa-core.js`

`index.html` now loads only those two runtime assets, plus required static assets. Historical source files remain build inputs/rollback references and are no longer requested individually by the browser.

The runtime bundle is generated deterministically by `scripts/build-runtime.cjs`, preserving the verified winning compatibility order while creating one deployable runtime generation.

A shared MutationObserver multiplexer keeps compatibility modules functional while reducing the underlying native observers to one.

Measured build metrics (`runtime-metrics.json`):
- frontend CSS/JS requests: **18 → 2**
- source CSS: **73,743 bytes**
- source JS: **74,717 bytes**
- consolidated CSS: **74,269 bytes**
- consolidated JS: **76,800 bytes** (includes the shared observer multiplexer)
- compatibility MutationObserver declarations: **10**
- native MutationObserver instances after consolidation: **1**
- dead `meehoa-v361.css` browser request: **removed**

The performance gain here is primarily fewer requests, fewer native observers, simpler cache invalidation and elimination of runtime version-file layering; it is not presented as byte-size minification.

### API runtime
Canonical branch implementation:
- `supabase/functions/meehoasg-api-core/index.js`
- build marker: `2026.10.04-core2`

The browser points directly to `meehoasg-api-core`; it no longer calls v36/v361/v362/v363/v364/v365 endpoints.

Critical startup/read paths are direct in core2:
- `loginAndBootstrap`
- `getCurrentUserAndBootstrap`
- `getProductionOrders`
- `getOrders`
- `getDashboardSummary`
- `getKpi`
- `getFlowerInventory`

Less-frequent compatibility/write operations that have not yet been reimplemented in core may fall back **one hop directly** to legacy `meehoasg-api`. There is no generation-to-generation proxy chain in the core.

## Preserved business contracts
Regression coverage explicitly protects:
- SALE sees all orders immediately, while edit permission remains owner-only.
- Dashboard and KPI use the same canonical Sale identity from `app_users` (`username` + `display_name`).
- KPI revenue is settled-only.
- Dashboard keeps split unsettled/settled revenue.
- Payment Check route/grid/select-all behavior remains available.
- Card quantity affects accessory pricing.
- Create/edit order image retention/removal remains available.
- Copy order info excludes Order ID and shortcut reload remains available.
- Materials keeps AI/local fallback and review behavior.
- Modal/drawer/lightbox close controls remain available.
- Single-scroll contract and mobile thumbnail/responsive fixes remain covered.
- Actual boot splash is styled without adding a transient extra loading screen.

## CI/build pipeline
PR CI now performs, in order:
1. flatten critical startup/read API routes into core2;
2. build the consolidated frontend runtime;
3. run the full regression suite;
4. persist generated core outputs back to the refactor branch.

Generated outputs are reproducible rather than hand-edited bundles.

## Remaining cutover checklist
Before changing production `main`:
- [x] one CSS + one JS browser runtime on refactor entrypoint
- [x] API browser path bypasses all historical version wrappers
- [x] critical startup/read routes implemented directly in API core2
- [x] one native MutationObserver runtime
- [x] regression suite migrated from old version-string assertions to consolidated behavior contracts
- [x] scroll contract preserved inside the consolidated CSS ordering
- [ ] deploy `meehoasg-api-core` as an ACTIVE non-production Edge Function
- [ ] final CI pass on the current PR head after documentation/final generated outputs
- [ ] production cutover to `main`
- [ ] post-cutover static smoke check and authenticated live acceptance

## Rollback
The pre-consolidation `main` commit remains the rollback baseline until cutover. Historical Supabase API functions are intentionally not deleted during the cutover window.

## Definition of done
The consolidation is complete when:
- production `index.html` loads `meehoa-core.css` + `meehoa-core.js` only;
- production browser requests `meehoasg-api-core` directly;
- core2 serves startup/read hot paths directly and never proxies through historical API generations;
- regression is green on the merged production commit;
- production static smoke check passes;
- authenticated desktop/mobile acceptance confirms the primary workflows.
