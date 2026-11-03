# MEEHOA OPS — READY FOR REVIEW

## Scope and evidence

- Base: `da36c66` on `main`. The previously reported `emergency-recovery-20261103` branch and `3173376` commit are absent from GitHub; this review branch does not claim to include that unshared work.
- Production website was read only on 2026-11-03: it serves `20261103-complete-plan-3` and routes requests through the Cloudflare Gateway.
- Production Supabase Core is active at version 20, build `2026.10.08-core6-atomic`. Its KPI code restricts Sale users to their own KPI. The repository Core code supports cross-Sale visibility and excludes C Mụi for other staff, so Core and website must be released together.
- The Gateway source introduced in `da36c66` contains a hard-coded privileged session token. This branch removes that source and sends the website directly to the existing Core route. Treat the token as compromised; deleting the file does not remove it from Git history or revoke the live session.
- Read-only database inspection found `cmui`, `test_sale_ops`, and `test_tho_ops` active. The two test accounts and C Mụi have unexpired sessions. `app_users` has no password change timestamp, so the database snapshot alone cannot establish when C Mụi's password changed.

## Review and release gates

1. Review the Core KPI authorization and the website route together. Test create, edit, deposit, Full Paid, Dashboard per Sale, Payment Check, KPI visibility for Admin/C Mụi/Sale/Thợ, and loading on a production-equivalent isolated environment.
2. Before deployment, verify a current production database backup and restore point, plus a rollback path for both website and Core. The repository rollback rehearsal uses isolated fixtures only and does not prove production recovery.
3. After separate owner approval, revoke the exposed privileged session and the two test account sessions; handle the test accounts and C Mụi password through the administrator's secure process. Do not place a replacement password or token in the repository.
4. Deploy Core and website as one coordinated release only after approval, then verify the live API route and business flows with authorized test data. If verification fails, restore the prior website and Core versions and reconcile any writes made during the release window before resuming service.

No merge, push, deploy, R2 migration, or production account/data change was performed for this review.
