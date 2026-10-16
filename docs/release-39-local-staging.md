# Local QA environment for PR #39

The requested cloud branch was cancelled and no Supabase cloud branch was created. This environment runs within the execution workspace and does not add a Supabase project/branch charge. It is not a public or persistent hosted staging service.

## What is running

- PostgreSQL 17.6, PostgREST 14.3 and real Supabase Storage 1.35.3 in dedicated Docker containers/volumes.
- Candidate core, legacy fallback and order-action business code on Deno 2.5.6. Only the listener port is adapted in gitignored runtime copies. Deno network permission is restricted to `127.0.0.1`.
- QA frontend: `http://127.0.0.1:4173`; local API gateway: `http://127.0.0.1:54321`.
- Frontend endpoint/key substitution is done by the QA web server. Production project references are rejected after substitution. Backend local settings are generated independently; no production keys, accounts or data are imported.
- This validates real SQL, sessions, uploads and UI interactions. It does not establish managed Supabase Edge packaging, gateway, backup/PITR, real-device Safari, public network latency or production Egress parity.

## Accounts and data

Primary accounts: `qa_admin` (ADMIN), `qa_sale` (SALE), `qa_tho` (THO_OPS). Additional `qa_sale_other` and `qa_disabled` verify cross-Sale and inactive-account denials. These are application `app_users` accounts, matching MEEHOA's actual login implementation.

Passwords are random and saved only to `artifacts/staging/credentials.local.json` with mode 0600. Local infrastructure keys are in `supabase.local.json` and `docker.local.env` in the same gitignored directory. **Do not commit or upload this directory.** No passwords are included in the sanitized evidence artifact.

Seed: 240 fake orders over three dates, including accents, username/display-name assignments, multi-banner/card quantities and cached flower varieties. Test-created orders use a separate future date. `staging-seed.cjs` accepts only the fixed loopback database port, checks a dedicated marker, refuses unmarked existing application databases and refuses automatic password rotation on populated QA databases.

## Recreate in a fresh workspace

Use the managed local Docker daemon (`unix:///var/run/docker.sock`); clear inherited Docker endpoint/context/TLS selectors as required by the environment. Do not point Compose at an external Docker host.

1. Install locked Node dependencies, Deno 2.5.6, and Playwright Chromium (see the CI `staging` job).
2. Run `node scripts/staging-config.cjs` once. It refuses to overwrite persisted QA credentials.
3. Run `docker --host=unix:///var/run/docker.sock compose --env-file artifacts/staging/docker.local.env -f infra/staging.compose.yml up -d --wait --wait-timeout 180`.
4. Run `node scripts/staging-seed.cjs` after Storage is healthy.
5. Set `MEEHOA_DENO` to the installed Deno binary and `DENO_DIR` to a writable QA cache directory; run `node scripts/staging-run.cjs`.
6. Run `node scripts/staging-acceptance.cjs`, then `node scripts/staging-browser.cjs`. Set `MEEHOA_CHROMIUM=bundled` for Playwright's installed browser, or a local Chromium binary path.

CI repeats this from an empty database and uploads only `artifacts/staging-evidence/`. It destroys only its disposable QA containers/volumes afterwards. Local manual QA should stop with Compose `down` **without `-v`** to preserve test accounts/data.

## Defect found by real API acceptance

An order with 500,000đ flowers, two cards and three banners has a 625,000đ total. Before the fix, “Đã thanh toán đủ tiền hoa (Full)” incorrectly reported 625,000đ collected and 0 debt. Both core and legacy read owners now use the 500,000đ flower amount for that status, leaving 125,000đ accessory debt. Verified Full Paid and settled orders still clear the complete order total. Tests also cover VAT/shipping and price-increase invalidation.

Local verification completed: 12 API scenarios PASS and 6 Chromium viewport/role combinations PASS. These counts describe these test scenarios, not automatic sign-off of all 12 original operator reports. The overall readiness ledger remains authoritative.
