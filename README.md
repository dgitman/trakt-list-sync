# Trakt list sync

The hourly list-sync schedule was retired on October 15, 2026 because Trakt list collaborators replace it. Only the daily watch-history job remains scheduled. List-sync code and stored state are retained. The protected disable operation could not be completed because 1Password authorization timed out; the hourly Cloudflare trigger was removed and verified.

Hourly bidirectional sync of David and Emalie’s private **DavEmalie** lists, plus daily watch-history date checks and automatic repairs. Both jobs run on Cloudflare Workers and share encrypted OAuth credentials, sync state, and repair journals in the existing Durable Object.

This is the canonical project, consolidating the original `trakt-list-sync` and `trakt-scrobble-check` code. Future fixes and deployments belong here.

## Hourly list sync: scope and conflict policy

The hourly job changes only list membership. It leaves history, ratings, watchlists, other lists, ordering, notes, and privacy untouched. The separate daily job repairs eligible watch-history dates as described below. Both account identities and pinned numeric list IDs are verified. Missing lists, incomplete pagination, unsupported media, and privacy changes fail closed.

Given the last verified common set B and current sets D and E, the target is `(D ∪ E) − ((B − D) ∪ (B − E))`. New additions propagate both ways; removal of previously synced entries wins. Movies, shows, seasons, and episodes use typed Trakt IDs.

Before every batch, both lists are reread. The journal is persisted before sending writes. Interrupted or partially applied batches resume from verified actual membership. Unexplained concurrent changes retain the journal and stop for review. The common baseline advances only after both full lists equal the target.

Trakt does not provide a compare-and-swap list mutation API. An edit in the gap between read and write can be indistinguishable from our operation. Removal and re-addition between hourly observations also cannot always be distinguished.

## Daily history behavior

- Checks complete paginated history for Unix-epoch placeholders and watches before a movie release or episode first-air timestamp.
- Repairs eligible entries using release timestamps, including episode runtime. Preserves repeat watches using distinct minute offsets when needed.
- Adds and verifies a replacement before removing the exact original history ID. A persistent cloud journal reconciles interrupted work without blindly repeating writes.
- Verifies per-title watches, history counts, and ratings including rating timestamps. Unknown release dates, future releases, invalid timestamps, and ambiguous changes remain for review.
- Processes up to 100 findings per account each run. Remaining findings are reported and checked on subsequent runs.
- Emails completed repairs, new remaining findings, and failures. Identical unresolved findings are deduplicated.
- Paces API calls and backs off on explicit rate-limit rejections.

The daily trigger runs at **12:35 UTC** (08:35 Eastern during daylight saving time, 07:35 in winter). No local scheduler is required.

## Production deployment

The Worker is `trakt-list-sync` in the Personal Cloudflare account:

`https://trakt-list-sync.dgitman-personal.workers.dev`

Set `SYNC_URL` to that URL for administration. The daily history job runs at 12:35 UTC; the hourly list-sync trigger has been removed. Email is sent from `trakt-sync@gitman.net` to `david@because.ventures`.

The existing Worker was renamed in place on October 5, 2026. Its secrets, Durable Object namespace, stored grants, baseline, repair journals, and both cron triggers were preserved. Retain the `DavEmalieSync` class, stable `davemalie` object name, encryption key, and migration configuration for future deployments. These names identify existing state and are independent of the project name.

The September 20, 2026 deployment repaired its initial 46 date findings. That historical verification does not establish the current operational status; use the authenticated `status` and `history/report` operations to inspect recent runs.

## Development

Requires Node 24+ and npm. Provisioning also uses Python 3 and the 1Password CLI.

```sh
npm ci
npm test
npm run typecheck
npm run dry-run
```

The 31 tests cover detection, pagination integrity, interrupted additions and deletions, repeat-watch preservation, concurrent changes, account isolation, rate-limit recovery, notification behavior, and existing list-sync behavior. Tests do not call live Trakt accounts.

## Deployment and secrets

```sh
npm run deploy
```

Authenticate Wrangler to the configured Cloudflare account first. The checked-in configuration points to the existing production Worker. Review its account, email destination, and schedules before deployment elsewhere.

Required cloud secrets: `ADMIN_KEY`, `ENCRYPTION_KEY`, `TRAKT_CLIENT_ID`, and `TRAKT_CLIENT_SECRET`. The encryption key must be a random 32-byte base64 value. Existing secrets and encrypted OAuth grants must be retained for production updates.

`scripts/provision-secrets.py` reads `ADMIN_KEY_REF`, `ENCRYPTION_KEY_REF`, `TRAKT_CLIENT_ID_REF`, and `TRAKT_CLIENT_SECRET_REF` from environment variables containing 1Password secret references. It streams values to Wrangler without saving or printing them. Never commit credentials, local operational configuration, OAuth token files, or personal history exports.

## Administration

Set `SYNC_URL` to the deployed Worker HTTPS URL and `ADMIN_KEY_REF` to its 1Password admin-key reference. All operations require the admin key. The client reads it directly through the 1Password CLI.

```sh
npm run admin -- status
npm run admin -- history/check
npm run admin -- history/report
```

`history/check` performs checks and repairs immediately. `history/report` returns the last complete findings, latest run status, and any pending repair journals. Completed repairs are also retained in Durable Object audit records.

Other operations retained for the hourly list sync: `snapshot`, `initialize`, `dry-run`, `enable`, `disable`, `run`, `auth/start`, `auth/poll`, and `notifications/test`. `enable` and `disable` apply to list sync, not the daily history job. To suspend daily repairs, remove only its daily cron trigger.

For a new deployment, authorize each account separately through `auth/start` and `auth/poll` with `{"side":"david"}` or `{"side":"emalie"}`. The Worker validates the expected identity before accepting a grant. Use independent cloud grants; do not reuse desktop MCP refresh tokens. Do not reauthorize an already working production deployment just to update its code.

## Recovery

An interrupted repair retains its journal. The next run reconciles actual history before changing it again. If an addition is ambiguous, the job stops and alerts rather than risking a duplicate or deleting the original. Inspect `history/report` before intervention. Missing release metadata is reported, not guessed. Release-date repairs are fallback dates, not recovered viewing dates.

The hourly list sync retains its baseline and pending operations independently. Never delete or reset the Durable Object to recover from an error.
