# MEEHOASG Production Consolidation — 2026-10-03/04

## Goal
Reduce runtime layering, duplicate observers and API proxy hops without changing production data or business behavior.

## Production status
The consolidation was merged to `main` on 04/10/2026.

Production merge commit:
- `b946762a50fcda797d787e8a1361e31c53e5db1a`

Post-merge evidence:
- main regression workflow: **SUCCESS**
- GitHub Pages build: **SUCCESS**
- GitHub Pages deploy: **SUCCESS**
- `meehoasg-api-core`: **ACTIVE v1**, JWT verification enabled
- main `index.html` loads the consolidated core asset generation and points browser API traffic to `meehoasg-api-core`

Historical assets/functions are retained temporarily as rollback references. No production database rewrite was performed by this refactor.

## Starting architecture confirmed

### Frontend
The browser previously requested 18 separate compatibility assets (10 CSS + 8 JS), spanning v3 through v365. One referenced CSS asset (`meehoa-v361.css`) did not exist, creating a dead request.

The separate JS generations also instantiated multiple MutationObservers against overlapping UI surfaces.

### API
The previous browser target was `meehoasg-api-v365`, with historical wrappers/fallbacks through v364/v363/v362/v361/v36 before legacy `meehoasg-api`.

## Consolidated production architecture

### Frontend runtime
Canonical browser assets:
- `assets/meehoa-core.css`
- `assets/meehoa-core.js`

Production `index.html` now loads only those two runtime assets, plus required static assets. Historical source files remain build inputs/rollback references and are no longer requested individually by the browser.

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
Canonical implementation:
- `supabase/functions/meehoasg-api-core/index.js`
- build marker: `2026.10.04-core2`
- Supabase function: `meehoasg-api-core`, **ACTIVE v1**, JWT verification enabled.

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
CI performs, in order:
1. flatten critical startup/read API routes into core2;
2. build the consolidated frontend runtime;
3. run the full regression suite;
4. on the refactor branch only, persist generated core outputs when they truly changed.

`runtime-metrics.json` is deterministic, so CI no longer creates a new commit merely because a timestamp changed.

## Cutover checklist
- [x] one CSS + one JS browser runtime
- [x] API browser path bypasses all historical version wrappers
- [x] critical startup/read routes implemented directly in API core2
- [x] one native MutationObserver runtime
- [x] regression suite migrated from old version-string assertions to consolidated behavior contracts
- [x] scroll contract preserved inside the consolidated CSS ordering
- [x] deploy `meehoasg-api-core` as ACTIVE
- [x] deterministic build pipeline established
- [x] final PR regression pass with no generated diff
- [x] production cutover merged to `main`
- [x] post-cutover main regression pass
- [x] GitHub Pages build/deploy pass
- [x] production static source check: main entrypoint references core assets/API
- [ ] authenticated desktop/mobile live acceptance by an operator account

## Rollback
Pre-consolidation production baseline:
- `f353ad48f70d05d30dd332c2198f24db93373347`

Consolidation merge:
- `b946762a50fcda797d787e8a1361e31c53e5db1a`

If the consolidated runtime must be rolled back during stabilization, revert the consolidation merge while leaving the v9.2 production data-flow triggers untouched. Historical Supabase API functions are intentionally not deleted during the stabilization window.

## Definition of done
All automated/build/deployment portions of the consolidation are complete. The final operational acceptance item is an authenticated desktop/mobile smoke check of the primary workflows on `ops.meehoasg.com`.
