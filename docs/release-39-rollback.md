# PR #39 controlled rollback plan

This is a procedure prepared for review, not permission to deploy, alter real records, restore production, or activate legacy writers.

## Before deployment

Record the candidate commit and CI `release-hashes-*` artifact, the currently deployed frontend and every API function version, migration ledger, Apps Script deployment/version and trigger configuration. Preserve the last known good complete artifact set. Confirm who can pause website mutations and every ingestion/writeback/queue writer, and verify the pause works on isolated staging first.

Verify managed database backup/PITR retention and an isolated restore target. Rehearse recovery there using synthetic records, including orders, settlement requests, operation receipts, activity log, delete queues, users/session policy, and Storage proof/image objects and references. Store recovery timing, row counts and monetary reconciliation. The repository PGlite rehearsal covers a local snapshot round trip only.

Before changing the database, snapshot the actual live definitions of affected total/finance/mutation/search functions and triggers and the migration ledger. The repository's captured production baseline has historical gaps and is not a substitute for a verified live backup. Record payment/settlement/debt counts and sums using a read-only approved reconciliation process.

## Triggers and containment

Stop rollout for financial total drift, duplicate/missing mutations, unexpected authorization, lost proof references, search privacy failures, or inability to match deployed artifacts to the validated SHA. Recovery owner pauses mutations and all external writers before changing versions. Keep proof objects and operation receipts for reconciliation; do not retry requests with new IDs until receipt state is known.

## Choose a compatible recovery

If no database changes or new writes occurred, restore the previously verified frontend/API artifact pair and cache version, validate hashes, then smoke-test against isolated records before reopening writes.

If the release schema has been applied, prefer a reviewed forward fix or a frontend/API rollback that remains compatible with the new schema. **Do not drop `banner_qty`, clamp quantities to one, or reinstall an old total/finance function after any order has more than one banner.** Old frontend/API versions can undercharge these records. Keep writes paused until the chosen version has passed multi-banner, Full Paid and settlement reconciliation against the current schema. Retaining additive columns and unused search functions is safer than destructive down migrations.

Restoring the pre-release database backup would discard legitimate writes after the recovery point. It requires explicit incident authorization, a documented recovery point and preservation/replay/reconciliation of those writes and proof objects on a separate target. Never automatically run a production restore from this PR or CI.

Never reactivate the legacy Sheet import or parallel Apps Script writer while website mutations remain active. Preserve the v9.2 production data flow unless an independently approved data-flow recovery procedure changes it.

## Verification and reopening

Verify restored artifact SHA-256 against its retained manifest and deployed file/function versions. Reconcile order/settlement/receipt/audit counts, banner totals, verified payment totals and debt sums. Validate role denials, idempotent retry, proof links, search and desktop/mobile smoke tests. Recovery owner records the evidence and authorizes reopening writers one at a time. Keep the incident log and both pre/post recovery snapshots.
