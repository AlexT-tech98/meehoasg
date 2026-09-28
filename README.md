# MEEHOASG

`index.html` is the GitHub Pages entry point for [meehoasg.com](https://meehoasg.com). The identical `html` file is retained as an editable copy. Both call the `meehoasg-api` Supabase Edge Function in project `zxnfhshnavbmvdthrmrd`; they do not call Google Apps Script. The old `code` file is retained only as a migration reference.

The API validates the existing usernames and SHA-256 password hashes, then issues opaque sessions stored as hashes in `app_sessions`. Supabase's legacy public `anon` JWT is used for platform Edge Function verification; it is public and carries no database privileges. The service-role credential stays in the Edge Function environment. All application tables have RLS enabled and no browser-access policies. Uploaded order images and settlement bills are private Storage objects, returned to authenticated users as time-limited signed URLs.

The applied schema is in `supabase/schema.sql`; the Edge Function source is in `supabase/functions/meehoasg-api/index.js`. The historical import was performed directly from the two source Sheets without storing customer records or password hashes in Git. The import contained 15 users, 5,125 orders, 249 settlement requests, 2,813 activity events, 1,213 performance samples, and the available flower-classification cache. Three source rows with missing or invalid dates were excluded. Duplicate order IDs were given a source-row suffix to preserve both records.

## Parallel trial

The old [Apps Script web app](https://script.google.com/macros/s/AKfycbwKbkc_4oHGB2lQHsAK4V7efMt6KeaOxGEWNqD6HiYzpntDlM2SHrYl3Z9vWkq1GbTv0w/exec) remains the operational system. [meehoasg.com](https://meehoasg.com) runs the Supabase implementation for owner review without a trial banner or read-only restriction. Changes on either system do **not** sync automatically; reports may diverge. Before switching operational traffic, resolve the legacy-login mismatch, run a delta import, and reconcile records.

The imported password hashes match all 15 rows in the source `USERS` sheet. Legacy login still needs validation against the Apps Script `PASSWORD_SALT` Script Property, which is not stored in the Sheet. The Supabase function currently uses the default `MEE-FLOWER-V4` unless `LEGACY_PASSWORD_SALT` is set. Do not replace hashes or reset users solely to work around this mismatch. Flower classifications already in the cache remain available; uncached descriptions require manual review until a new classifier is configured.
