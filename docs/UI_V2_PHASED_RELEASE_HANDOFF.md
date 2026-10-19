# MEEHOA UI V2 — handoff for the next AI agent

Decision approved by the owner on 2026-10-18: release the new UI V2 features first **if the operational release gates pass**. Defer CSS cleanup that is proven cosmetic and noncritical to a follow-up change. Do not ask the owner to reconfirm this sequencing. This supersedes the earlier rule that every inherited CSS override must be removed before deployment. It does **not** waive functional, visual, financial, permission, rollback or production-readiness checks.

## Where to continue

- Repository: `AlexT-tech98/meehoasg`; PR [#47](https://github.com/AlexT-tech98/meehoasg/pull/47); branch `feat/ui-v2-clean-replacement`.
- Last implementation SHA before this handoff: `e7089804bc2cfc9fb64beff1819204674e0f9ece`. Fetch the branch and use its actual HEAD; do not reset to this SHA. The handoff commit will advance HEAD, so the listed CI is **not** final-HEAD evidence.
- PR is open and draft. Nothing in UI V2 has been merged or deployed by this handoff.
- Start with `docs/UI_V2_IMPLEMENTATION_CONTRACT.md`, `docs/UI_V2_CLEAN_SOURCE_AUDIT.md`, `runtime-ownership.json`, `runtime-metrics.json`, and the release/rollback docs for PR #39. Those PR #39 runbooks are references, not blanket authorization to apply their migrations or writer changes to UI V2.
- Project-mirror `sources/` files are read-only. Never edit synced project files.

## What is already verified

- Navy theme and approved Production path are implemented: `Chờ bó → Đã bó → Chờ giao` for delivery/customer-booked orders **or** `Chờ lấy` for pickup → `Đã giao`. Checkbox selection and opening a drawer must not change status.
- Canonical UI JavaScript uses direct render hooks and has zero `MutationObserver` patch calls. The core bundle no longer installs an observer multiplexer.
- Forty-six branding, shipping and loading/page-status CSS override declarations were moved from the Production stylesheet to the Shell owner. The active CSS still has **1,135** `!important` declarations. This count is debt, not proof of a defect.
- GitHub Actions run [39133098973](https://github.com/AlexT-tech98/meehoasg/actions/runs/39133098973) passed on `e708980`: regression, independent PostgreSQL transaction tests, deterministic build/release package, isolated rollback fixture, browser desktop/mobile by role, authenticated synthetic staging API/storage/finance/roles, real-backend browser matrix, benchmark, compatible fallback and PostgreSQL/Storage restore. These are **synthetic/local** checks, not production evidence.
- Local baseline on that SHA: `npm run build` passed; 241 tests passed, 0 failed, 3 real-PostgreSQL tests skipped locally because `AUDIT_DATABASE_URL` was unset (they ran in CI); isolated browser matrix passed 6/6 using Chrome.

## Release-first scope: what must be done before deployment

1. **Classify CSS by effect, not by `!important` count.** Audit Shell/nav/topbar, Orders/list/drawer, Production, KPI, Debt, Payment, Materials and Admin on desktop and narrow mobile screens, with ADMIN, SALE and THO_OPS roles. Fix before release any overlap that hides a control, changes readable meaning, prevents scroll/close, breaks action placement or touch access, changes a status/payment cue, or differs materially from the accepted navy design. Keep visual evidence and record each deferred issue with selector, owner, screenshot and why it is cosmetic. Do not add a new override tail, observer, hotfix asset or duplicate handler to make the release pass.
2. **Prove business parity on the final candidate.** Exercise create, edit, save, copy and delete; Full Paid and accessory balance; settlement/Payment Check, owner-only debt, KPI settled revenue, image add/retain/remove/paste, Materials fallback, search, authorization and all approved Production transitions including bulk guards. Compare API/SQL status readers and writers and historical-order translation. No silent status update and no unauthorized mutation.
3. **Check production-readiness inputs.** Capture the exact deployed frontend/API/SQL/writer versions and source hashes, current backup availability and recovery point, compatible rollback artifact, and a named rollout/rollback operator. Verify whether this UI V2 candidate needs any backend, migration or Apps Script change; never apply a PR #39 step merely because it appears in its runbook. Reconcile existing production baseline read-only. No customer-order smoke mutation without an isolated approved test record.
4. **Run all gates on the last code SHA.** Rebuild and compare bundles, run regression plus real PostgreSQL transactional tests, desktop/mobile browser matrix, authenticated local staging backend, rollback rehearsal and CI. If code changes, rerun the affected checks and require exact-HEAD green CI. A clean CSS debt count alone is neither necessary nor sufficient for this phased release.
5. **Controlled rollout only after items 1–4 pass.** Preserve the last-known-good frontend and every changed backend artifact, follow a reviewed rollback sequence, verify deployed hashes, then run read-only/isolated production smoke checks and watch errors, finance/debt totals, sync behavior, performance and egress. Stop/rollback for a finance mismatch, missing proof, wrong role access, status drift, failed save or inability to match the deployed SHA. Mark operational DONE only after post-deploy evidence is recorded.

The owner has approved **this phased approach**. It is not a claim that today's PR is ready to merge or deploy. Do not request repeated approval for the same sequencing. If a required external production fact or deployment permission is unavailable, finish all independent preparation first, then state precisely what is missing, who must provide it and why.

## Work after the feature release

Create a separate follow-up change for the deferred, documented cosmetic CSS debt. Continue replacing overlaps inside the owning module until the Clean Architecture / Zero Patch Layer source goal is met. Keep regression and visual parity tests; do not make the deployed feature release depend on eliminating all 1,135 declarations when they have been proven noncritical.

## Handoff and stopping rule

The next AI agent owns the remaining audit, fixes, final-SHA verification, PR evidence and release preparation. Do not stop merely to report progress. At a genuine handoff or blocker, report in plain Vietnamese: (1) what users can now do or what was verified, (2) exactly why work stopped, (3) the next concrete action and (4) who will do it. Do not say DONE for a green CI run alone.
