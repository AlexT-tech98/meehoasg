# MEEHOA UI V2 — Implementer contract
Status: IN PROGRESS, NOT DEPLOY APPROVED. Reference: approved UI-V2 handoff, 2026-10-18.

## Immutable business boundaries
Preserve production login, authorization, order create/edit/save/copy/delete, price and payment math, debt and settlement request permissions, KPI settled revenue, role-based editing, images, sync and search. Never use mockup data as seed data.

## Approved visuals
Linear + Vercel visual hierarchy with **existing production navy** theme. Keep real navigation: Dashboard, Production, Orders, Debt, Payment Check, KPI, Materials, Settings. Desktop left sidebar and topbar; mobile compact navigation, full-height order details. Unify spacing, typography, borders, action bars, status badges, tabular-number formatting, empty/loading/error states and narrow layouts. Avoid decorative illustrations and oversized cards.

## Production fulfillment exception
Requested path: Chờ bó -> Đã bó -> [Chờ giao for Shop book ship/Khách tự book; Chờ lấy for Ghé lấy] -> Đã giao.
Before changing persistence: inventory status readers/writers in frontend, Edge Functions, Supabase, historical Sheet writer, KPI and settlement rules. Decide whether intermediate states are persisted or derived views, and test both paths. Checkbox selection and drawer open must NEVER change order status. No silent automatic status update. Avoid migration until backend and historical compatibility are verified.

## Required module replacements
1. Shell: single sidebar/topbar/nav controls and one scroll owner.
2. Dashboard: KPI strip, urgent orders, progress, receivables, salesperson summary.
3. Production: Kanban/Grid preserving bulk action guards and selected orders.
4. Orders: list/search/filter and responsive order-detail drawer, preserving all actions.
5. KPI: existing settled/unsettled rules, commissions and identities.
6. Debt/Payment/Materials/Admin: presentation-only clean-up; preserve contracts.

## Zero-patch acceptance gates
- No new CSS override tail, generic MutationObserver UI rewriting, shadow copy of existing render functions, event listener duplication, or vNN hotfix asset in build.
- Feature ownership declared exactly once and built deterministically into meehoa-core.css/js.
- Obsolete implementation removed from active source list *when replacement passes*; Git history preserves rollback.
- Tests for desktop/mobile, roles, status selection, save/edit, full-paid orders, production bulk operations, KPI equality, debt/settlement and old/new imagery.
- CI green AND production smoke checks before deploy approval. Compare bundle, API payload and production metrics against baseline.
- Do not conflate a mergeable PR or GitHub PASS with end-to-end operational PASS.

## Release sequencing
Baseline SHA/screens and functionality -> replace one module at a time -> run characterization/regression tests -> prune old ownership -> build -> CI -> staging parity -> deploy only after explicit readiness checklist.
