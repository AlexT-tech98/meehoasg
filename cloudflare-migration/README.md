# MEEHOA OPS Staging — Cloudflare Worker Runtime

Clean, reproducible source of the Cloudflare OPS Staging service (`meehoasg-ops-staging`).

## Included vs Excluded
- **Tracked in Git:** `runtime/` (Worker API, D1/R2 adapters, shared `order-rules.js`), `public/` (frontend source, sanitized of legacy Supabase URLs/JWTs), `schema/schema.sql` (DDL-only structure, zero data), `build-frontend.mjs`, guarded `build-backend.mjs`, `wrangler.toml`, `tests/`.
- **Never committed (`.gitignore`):** `generated/`, `live-snapshot/`, `private-backup/`, `dist/`, `node_modules/`, `.dev.vars`, `.wrangler/`, `*.before-*`, `reconciliation-report.json`.

## Build, Test, and Staging Deploy
```bash
cd cloudflare-migration
npm run build   # Builds frontend assets into dist/ ONLY; never overwrites runtime/*.js
npm test        # Runs all OPS unit, parity, media, and order-rules contract tests
npx wrangler deploy  # Deploys meehoasg-ops-staging (Staging only)
```

> `build-backend.mjs` is an opt-in legacy migration script from `live-snapshot/` and refuses to run unless `ALLOW_OVERWRITE_RUNTIME=1` is explicitly provided.
