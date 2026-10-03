# MEEHOASG Production Consolidation — 2026-10-03

## Goal
Reduce runtime layering and maintenance risk without changing current business behavior or production data.

## Safety contract
- `main` / current production stays untouched until the consolidated build passes regression + live acceptance.
- No production database rewrite as part of the frontend consolidation.
- Keep current production commit as rollback baseline.
- Consolidation happens on `refactor/consolidate-production-core-20261003`.

## Confirmed layering today

### Frontend entrypoint
`index.html` currently injects multiple generations at runtime:

CSS:
- `meehoa-v3.css`
- `meehoa-v3-fix.css`
- `meehoa-v3-hotfix.css`
- `meehoa-v34.css`
- `meehoa-v35.css`
- `meehoa-prod-fix.css`
- `meehoa-v361.css`
- `meehoa-v362.css`
- `meehoa-v364.css`
- `meehoa-scroll-contract.css`
- `meehoa-v365.css`

JS:
- `meehoa-v3.js`
- `meehoa-v34.js`
- `meehoa-v35.js`
- `meehoa-v361.js`
- `meehoa-v362.js`
- `meehoa-v363.js`
- `meehoa-v364.js`
- `meehoa-v365.js`

This means fixes are frequently expressed as later overrides rather than edits to one canonical implementation.

### API chain
The active frontend targets `meehoasg-api-v365`.

Confirmed upstream chain:

`meehoasg-api-v365`
→ `meehoasg-api-v364`
→ `meehoasg-api-v363`
→ `meehoasg-api-v362`
→ `meehoasg-api-v361`
→ `meehoasg-api-v36`
→ legacy `meehoasg-api`

Some layers short-circuit individual operations, but fallback/proxy behavior still exists across generations. This adds request hops and makes ownership of a behavior difficult to reason about.

## Consolidation target

### Frontend
Move to one canonical runtime generation:
- `assets/production-core.css`
- `assets/production-app.js`

Rules:
- No version-to-version override chain.
- One listener per interaction.
- One MutationObserver only where strictly required; prefer direct render hooks.
- One responsive system.
- One modal/drawer contract.
- One scroll-root contract.
- Preserve current behavior for Orders, Production, Dashboard, Payment Check, Materials, KPI, order create/edit, image management, role permissions and shortcuts.

### API
Move to one canonical API endpoint implementation:
- `supabase/functions/meehoasg-api-production/index.js`

Rules:
- Direct database implementation for production operations.
- No generation-to-generation HTTP proxy chain.
- Preserve current auth/session contract, SALE read-all/edit-own rule, settlement behavior, card quantity pricing, Dashboard settlement split, image retention, Materials fallback/AI behavior, and compatibility response shape required by the frontend.

## Execution phases

### Phase 1 — inventory and ownership map
- Map every loaded CSS selector to its final winning rule.
- Map every patched frontend function/event/observer to the final runtime behavior.
- Map API operation names and determine which generation currently owns each operation.
- Flag duplicate listeners, observers, render passes and proxy calls.

### Phase 2 — build canonical frontend
- Merge final CSS into `production-core.css`.
- Merge final JS into `production-app.js`.
- Change branch-only entrypoint to load canonical assets only.
- Keep old assets in repository temporarily for diff/rollback, but do not load them.

### Phase 3 — build canonical API
- Flatten current `v36 → v365` behavior into one implementation.
- Add operation-level regression fixtures before replacing the endpoint.
- Deploy as a new non-production function name first.

### Phase 4 — benchmark and acceptance
Test desktop + mobile for:
- cold app open / shortcut open
- returning app open
- login/session restore
- Dashboard first meaningful data
- Orders load/search/filter
- Production Grid/Kanban
- Payment Check select-all/bulk approval
- Materials
- order create/edit with image add/remove
- modal/drawer/lightbox close behavior
- scroll smoothness / no nested page scroll
- SALE read-all/edit-own

Measure at minimum:
- number of CSS/JS requests
- JS/CSS transferred bytes
- API request count for initial Dashboard
- time to shell mounted
- time to Dashboard data visible
- duplicate API calls during one navigation

### Phase 5 — cutover
Only after regression and live acceptance:
- point production entrypoint to canonical frontend assets
- point frontend to canonical production API
- keep previous production commit/function available for immediate rollback
- remove obsolete runtime references from `index.html`

## Definition of done
- Production entrypoint loads one canonical CSS and one canonical JS bundle (plus required static assets only).
- Frontend does not rely on historical `v3/v34/v35/v361/v362/v363/v364/v365` override order.
- Production request path does not proxy through historical API generations.
- Existing regression suite passes after being rewritten to test canonical behavior, not old filenames/version strings.
- Mobile and desktop live acceptance passes before merge to `main`.
