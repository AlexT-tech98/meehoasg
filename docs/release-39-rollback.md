# PR #39 controlled rollback plan

This is a procedure prepared for review, not permission to deploy, alter real records, restore production, or activate legacy writers.

## Before deployment

Record the candidate commit and CI `release-hashes-*` artifact, the currently deployed frontend and every API function version, migration ledger, Apps Script deployment/version and trigger configuration. Preserve the last known good complete artifact set. Confirm who can pause website mutations and every ingestion/writeback/queue writer, and verify the pause works on isolated staging first.

Verify managed database backup/PITR retention and an isolated restore target. Rehearse recovery there using synthetic records, including orders, settlement requests, operation receipts, activity log, delete queues, users/session policy, and Storage proof/image objects and references. Store recovery timing, row counts and monetary reconciliation. The PGlite rehearsal checks pre/post-release snapshots. The real local drill (`staging-restore.cjs`) additionally restores pg_dump into a fresh database and archived files into an independent Storage volume/API, comparing financial totals, row hashes and signed proof bytes. This establishes local recovery mechanics, not production PITR availability. No paid cloud staging is required for this rehearsal.

Before changing the database, snapshot the actual live definitions of affected total/finance/mutation/search functions and triggers and the migration ledger. The repository's captured production baseline has historical gaps and is not a substitute for a verified live backup. Record payment/settlement/debt counts and sums using a read-only approved reconciliation process.

## Triggers and containment

Stop rollout for financial total drift, duplicate/missing mutations, unexpected authorization, lost proof references, search privacy failures, or inability to match deployed artifacts to the validated SHA. Recovery owner pauses mutations and all external writers before changing versions. Keep proof objects and operation receipts for reconciliation; do not retry requests with new IDs until receipt state is known.

## Choose a compatible recovery

If no database changes or new writes occurred, restore the previously verified frontend/API artifact pair and cache version, validate hashes, then smoke-test against isolated records before reopening writes.

If the release schema has been applied, prefer a reviewed forward fix or a frontend/API rollback that remains compatible with the new schema. **Do not drop `banner_qty`, clamp quantities to one, or reinstall an old total/finance function after any order has more than one banner.** Old frontend/API versions can undercharge these records. Keep writes paused until the chosen version has passed multi-banner, Full Paid and settlement reconciliation against the current schema. Retaining additive columns and unused search functions is safer than destructive down migrations.

Restoring the pre-release database backup would discard legitimate writes after the recovery point. It requires explicit incident authorization, a documented recovery point and preservation/replay/reconciliation of those writes and proof objects on a separate target. Never automatically run a production restore from this PR or CI.

Never reactivate the legacy Sheet import or parallel Apps Script writer while website mutations remain active. Preserve the website-first v9.2 data flow; the reviewed v9.4 metadata writer appends banner quantity without changing handler names or existing column positions. Preserve that unless an independently approved data-flow recovery procedure changes it.

## Verification and reopening

Verify restored artifact SHA-256 against its retained manifest and deployed file/function versions. Reconcile order/settlement/receipt/audit counts, banner totals, verified payment totals and debt sums. Validate role denials, idempotent retry, proof links, search and desktop/mobile smoke tests. Recovery owner records the evidence and authorizes reopening writers one at a time. Keep the incident log and both pre/post recovery snapshots.

## Packaged compatible fallback

The release archive includes `compatible-fallback/` from prior green commit `52718b2cd9311891297e4666dfeba4a72629b463`. Read-only Deno comparison against the upgraded QA database verifies multi-banner, Full Paid and flower-only financial response parity. This is a known older search/UI fallback, not a reversal of all fixes. Keep release database/functions, ingest/feed and v9.4 metadata writer; do not substitute an arbitrary old production writer. Apply fallback frontend and API core/legacy/shared files together, preserve the archive manifest, then reconcile before resuming writes. This drill does not authorize production use.

Apply only the five delta migrations in `scripts/release-migrations.json`; do not replay reconstructed historical migrations against the live divergent ledger. Retain SQL execution receipts, actual pre-change definitions and the mapping to generated migration versions.
