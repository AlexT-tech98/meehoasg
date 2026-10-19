# UI V2 release validation

This document describes repository changes and public CI evidence. It is not a production acceptance receipt. Detailed operational evidence is retained outside the public repository.

## Candidate changes

- Preserve the five-state fulfillment path: Chờ bó → Đã bó → Chờ giao or Chờ lấy → Đã giao.
- Render banner quantity in Orders debt notes.
- Keep Production status actions clear of duplicate accessory labels and wrap long Full Paid text inside narrow cards.
- Retain day-two orders after mutations in a selected Production date range; handle date edits inside, outside and back into that range without duplicates.
- Match existing UI/legacy reader roles in the canonical core: Dashboard ADMIN; Production ADMIN/THO_OPS; preserve SALE Orders access.

Changes remain in the declared HTML/CSS/API owners and deterministic runtime bundles. No new observer-based rendering or CSS override tail is introduced.

## Reproducible checks

[CI run 39186496747](https://github.com/AlexT-tech98/meehoasg/actions/runs/39186496747) passed test, browser and staging on implementation/recovery commit `9bee65071e42684e62a9bcb17f6b92c08670be4b`. Later changes require their own exact-commit CI result.

`scripts/five-state-fallback-rehearsal.cjs` loads the actual packaged recovery frontend. It evicts only the cached shell, fixes the fixture clock, verifies five browser-served resource hashes, and checks all fulfillment states, forward/backward transitions, a two-day picker, SQL/client/DOM membership, role denials, and money/proof invariants. SQL is isolated PGlite; authentication and transport are synthetic. It does not prove a production restore.

`scripts/staging-acceptance.cjs`, `scripts/staging-browser.cjs`, and `scripts/staging-restore.cjs` cover authenticated isolated APIs, browser workflows, PostgreSQL and independent Storage recovery. Preserve their stated scope and configured acceptance thresholds.

The frontend recovery anchor is corrected green commit `6d41af509775d33350a2c29e15bd0cbec84cee29`. Restore its five frontend files together and retain the matching upgraded SQL/API. Do not downgrade stored statuses, replay earlier release migrations or overwrite legitimate writes.

## Release decision

CI success alone is not operational DONE. Merge/deployment remain conditional on operational acceptance and the approved controlled rollout. Keep the PR draft while those conditions remain unresolved.
