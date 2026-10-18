# UI V2 production checkpoint — 18 October 2026

This checkpoint records live read-only evidence and release-candidate corrections. It is not a production acceptance receipt. Keep PR #47 draft until the outstanding operational gates below pass. The owner has deferred Google Apps Script work; do not require another approval for that scope decision or enable a legacy writer.

## Live baseline captured by Codex

Network access and Chromium inspection now work using supported execution network permissions. The earlier proxy-blocker conclusion is superseded. Chromium verifies TLS using the supplied environment CA in a disposable, domain-constrained profile.

At 18:43 UTC, production's five release files matched `main` commit `f30a13bc63ff9474d628590019dfcb84bd1e4416`, not V2:

| File | Served SHA-256 |
| --- | --- |
| index.html | 00d3f4aa9136670941d97baa94923a4f28fd547ab8ee081e74f67a639639e3af |
| html | 17ed2106312296bed1af67339fd1aaddcb596918bf2ee4fad3cf5064404e5b62 |
| assets/meehoa-core.css | c717ce3f2e0e44682493f57cefc31ac0e9e129f7c3b04ed9ac3cf3e1c7d713c8 |
| assets/meehoa-core.js | a962dc799c06477c6690a2cfaf5f8c2d93addcce70be1bc260b795509754af70 |
| manifest.webmanifest | 2775469081f67bcdd08abfec25aa2164d1dbd9a49e0a7ce334711b2fc247df4e |

Chromium 1440px and 390px login renders: HTTP 200, inputs/button visible, no horizontal overflow, page errors or failed requests. No credentials were guessed and no customer orders were mutated.

Production project `zxnfhshnavbmvdthrmrd` remains healthy. Live core v14, legacy v21, order-actions v6, ingest v11 and writeback-feed v5 sources were retained separately. Core, legacy, ingest and feed match their main entrypoints. Order-actions retains an older shared operations module with sequential Full Paid image/bill uploads; deploy its matching shared module with the release even though its entrypoint itself matches the candidate. Do not infer all deployed shared modules from one function's bundle.

At 18:38 UTC there were 6,095 orders, 2,217 settled and 178 Full Paid. Canonical total was 2,082,837,388; settled total 732,119,380; Full Paid collected total 100,674,000. These are time-sensitive pre-release totals, not a post-deploy reconciliation. Duplicate order IDs, APPROVED requests on unsettled orders, and PENDING requests on settled orders were all zero. Orders constraint and mutation RPC still admit three states only; mutation definition MD5 is `141c34812d767c2a1d193553108a2cf9`. The V2 migration is absent.

RLS is enabled on orders/users/sessions/settlements/receipts. Both `anon` and `authenticated` lack table SELECT and mutation/search RPC EXECUTE; service-role execution remains allowed. Live unauthenticated Orders, Dashboard and KPI calls returned `AUTH_REQUIRED`; direct Orders REST read returned 401; private Storage listing exposed no objects. This is an anonymous authorization check, not an authenticated role matrix.

Private Storage metadata counted 785 order-image objects (270,736,682 bytes) and 347 settlement-bill objects (89,970,877 bytes). Metadata is not an object backup. Signed-byte retrieval and recovery need separate evidence.

Log baseline, 17:45–18:40 UTC: gateway 894 requests; function gateway 60 requests; Storage 623 HTTP-200 records plus four records without a status. No recorded HTTP 5xx; function events showed Boot/Shutdown only. Logged response lengths: gateway 19,429,650 bytes, function gateway 1,275,563, Storage 17,561,428. Do not add overlapping service logs together or call these billed Egress totals. They do not establish post-release performance or Egress acceptance.

## Corrections required before release

- Orders debt note used a fixed 35,000 banner charge even for multiple banners. Its canonical owner now renders quantity × 35,000 and quantity text, with behavioral regression coverage.
- An absolute duplicate accessory pseudo-label covered Production status buttons. Remove it from Kanban/Grid owners while retaining the explicit accessory badge and Orders mobile styling.
- Long Full Paid text overflowed narrow five-lane cards. Allow wrapping inside the Production financial row; browser assertions inspect text glyph bounds and both view modes.

The original `301cf981fff8040ef54a4d11a16aae22d82d1888` five-state fallback frontend is byte-identical to the original e844aff frontend and inherits these visual defects. The strict browser/SQL rehearsal correctly rejects its clipped Full Paid text. Recovery is now pinned to corrected implementation `4bb73ffb594118e5b14463772d423ec5320973bc`, whose [CI run 39155728940](https://github.com/AlexT-tech98/meehoasg/actions/runs/39155728940) passed test/browser/staging. Retain upgraded five-state SQL/API and never overwrite legitimate writes. Reinstalling these verified frontend files is a compatible recovery option, not a claim that a different previous UI cures every possible incident.

`scripts/five-state-fallback-rehearsal.cjs` loads the actual packaged recovery frontend after a candidate-page reload and runs canonical SQL mutations in isolated PGlite. It checks all statuses, pickup/delivery forward and backward transitions, selection-no-mutation, mixed bulk guards, money/Full Paid/KPI and proof-identity invariants, owner-only settlement and SALE status denial at 1440px/390px across ADMIN/SALE/THO_OPS. Authentication/transport and proof bytes are synthetic; it is not a managed-production restore. The browser CI job runs this rehearsal and uploads its evidence.

Additional retained live source now covers all 15 deployed Edge Functions, including historical wrappers, deletion/recovery and settlement ingest. A local public-business-table write-guard proof passed, but it does not stop pre-RPC Storage uploads or certify a drained live pipeline; it remains a review artifact, not a production change.

The automatic approval reviewer rejected provisioning four dedicated production QA accounts, including an ADMIN, because the general testing request did not explicitly authorize that security scope. No QA account was inserted; explicit owner approval is pending. No employee sessions are reused or forged.

## Outstanding operational acceptance

1. Run exact-final-SHA regression, independent PostgreSQL transactions, desktop/mobile by role, and actual packaged five-state frontend recovery rehearsal. Local/synthetic recovery is not live production recovery.
2. Exercise a reversible website/API mutation freeze/reopen, including uploads and alternate mutation entrypoints. Disabling app users alone is not universal containment. Deferring Apps Script implementation does not prove that unknown external writers are paused.
3. Verify an actual usable production backup and recovery to a separate target, including independent Storage bytes. The earlier daily-backup screenshot and restore UI do not prove a completed restore. Current connectors expose SQL/function operations, not managed-backup download/restore inventory or private Storage credentials.
4. Test authenticated production ADMIN/SALE/THO_OPS flows using isolated QA accounts/records. Do not reuse local staging credentials, impersonate employee sessions, or change customer records to produce a PASS.
5. Only after the gates pass: merge, controlled matching SQL/API/frontend rollout, served-hash verification, real smoke/finance/permission/image checks, and sync/error/performance/Egress observation. Record actual evidence before operational DONE.

Raw retained baseline artifacts and browser screenshots are under `/workspace/prod-baseline`; no production credentials or customer rows are included in this document.
