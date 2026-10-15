# PR #39 release evidence and remaining gates

Status: **NO-GO — not READY TO DEPLOY**. Keep this single PR as draft. No production writes or deployment are authorized by this document.

Issue #36 contains **13 technical checks for 12 operator reports**. A successful source test or synthetic browser response cannot mark the operational report PASS.

## Reproducible evidence

- `npm ci --ignore-scripts && npm run build`; generated files must produce zero `git diff`.
- `npm test`: source/functional and isolated PostgreSQL WASM tests. CI separately runs the transactional suite on PostgreSQL 16 with independent sessions.
- `node scripts/browser-acceptance.cjs`: actual shell and generated CSS/JS in Chromium, widths 1440/390, ADMIN/SALE/THO_OPS, synthetic API only. All external requests are intercepted. Produces screenshots, Playwright traces and request-name/check results in `artifacts/browser/`.
- `node scripts/rollback-rehearsal.cjs`: migrates fresh PostgreSQL WASM fixtures, verifies legacy banner financial parity, 3-banner total, and exact row/total restore from both pre-release and post-release snapshots. Produces `artifacts/rollback/results.json`. This does not test managed database PITR, roles, Storage, or external writers.
- `node scripts/release-manifest.cjs`: refuses a dirty tracked tree; records commit and SHA-256 of every tracked file in `artifacts/release/`. CI uploads all evidence under the exact validated head SHA. CI never changes the branch it validates.
- [Read-only public static parity](validation/release-39-public-static-parity.json): live `index.html`, `html` and both core assets match the current `main` byte for byte. Candidate differences are expected before deployment. Edge Function and Apps Script parity remain unverified.

Local Chromium can be selected with `MEEHOA_CHROMIUM=/usr/bin/chromium`. CI installs the pinned Playwright Chromium. Viewport emulation is not an iOS/Safari device test. Cold/warm durations in browser results measure local fixture UI only; they are not production API P50/P95 or Egress measurements.

## Acceptance ledger

| #36 check | Existing/added evidence | Required to mark operational PASS |
|---|---|---|
| 1 Payment labels | Full Paid functional/source tests | Authenticated desktop/mobile comparison across payment modes |
| 2 Desktop Dashboard parity | Browser confirms authorized Sale report visible at both widths | Staging role matrix and live API totals |
| 3 Eligible debts and Tiên scope | Debt source checks, transactional role tests | Exact fixture reconciliation; approved operator scope; read-only production comparison if authorized |
| 4 Cold/warm P50/P95 and calls | Browser records local durations and verifies fresh Orders revisit adds no call | Representative repeated staging cold/warm samples, API/network/Egress budgets and results |
| 5 Canonical CSS | Ownership/build tests and zero generated diff | Visual regression across modules on staging |
| 6 All-date bounded search | PostgreSQL normalization/pagination tests | Staging authenticated privacy, explicit optional date range and pagination scenarios |
| 7 Selection only | Actual browser checkbox selects, preserves status, sends no mutation | Staging explicit action changes selected records only |
| 8 Settlement permission | PostgreSQL THO_OPS/SALE submission and Admin-only approval tests | Policy approval record and authenticated staging proof/upload/denial cases |
| 9 Multi-day flowers | Range source tests | API-backed multi-day distinct-order/variety fixture reconciliation |
| 10 Per-Sale order counts | Browser renders 36 fixture orders per Sale | Staging DB/API/report reconciliation |
| 11 Banner quantity | Browser drawer ×3, atomic finance tests, restore rehearsal | API-backed create/edit/backward compatibility and finance/security review |
| 12 Sticky navigation | Actual scroll geometry at both widths/all roles | Safari/device and staging overlay/scroll checks |
| 13 Blank new date | Browser new date blank/required, edit saved date retained | Staging invalid submit rejects; create/edit persists correct date |

## Release blockers

1. No isolated staging endpoint or test-account credentials are configured in this execution environment. Do not substitute production accounts/data for staging.
2. Complete authenticated API-backed desktop/mobile E2E for all 13 checks, including financial mutations on disposable records; retain reconciliation, request IDs, traces and CI SHA.
3. Confirm the business approval provenance for active-user debt/settlement scope introduced in #37; retain Admin-only approval. Do not infer approval from a green test.
4. Review global search date filtering, privacy, scale and query plan; review banner migration and financially verified historical orders. Do not mark performance PASS from static assertions.
5. Verify staging restore/PITR and Storage recovery, then record production backup availability and recovery owner without changing production data. Follow [rollback plan](release-39-rollback.md).
6. Record release artifact/hash parity for Pages, deployed Edge Functions and Apps Script/writeback baseline. Post-deploy operational verification is a separate gate that can only be completed after an approved deployment.

Release approval needs: exact commit, green CI links/artifact IDs, all 13 technical checks signed off against the 12 reports, staging reconciliation, finance/security review, recovery rehearsal evidence and approved deployment/rollback owner. Missing evidence means NO-GO.
