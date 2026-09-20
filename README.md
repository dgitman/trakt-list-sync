# Trakt list sync

Hourly, bidirectional membership sync for the two private **DavEmalie** lists. The application runs entirely on Cloudflare Workers, using a SQLite Durable Object for encrypted OAuth credentials, the verified baseline, and the pending operation journal. No local scheduler, daemon, browser session, or running Mac is required.

The local scripts are one-time deployment and administration tools, not the sync runtime.

## Scope and conflict policy

Only list membership is changed. History, ratings, watchlists, other lists, ordering, notes, and privacy are untouched. Both account identities and pinned numeric list IDs are verified. Missing lists, incomplete pagination, unsupported media, and privacy changes fail closed.

Given the last verified common set B and current sets D and E, the target is `(D ∪ E) − ((B − D) ∪ (B − E))`. New additions propagate both ways; removal of previously synced entries wins. Movies, shows, seasons, and episodes use typed Trakt IDs.

Before every batch, both lists are reread. The journal is persisted before sending writes. Interrupted or partially applied batches resume from verified actual membership. Unexplained concurrent changes retain the journal and stop for review. The common baseline advances only after both full lists equal the target.

Trakt does not provide a compare-and-swap list mutation API. An edit in the gap between read and write can be indistinguishable from our operation. Removal and re-addition between hourly observations also cannot always be distinguished.

## Deployment

The Worker is deployed in the Personal Cloudflare account at
`https://davemalie-sync.dgitman-personal.workers.dev`.
The native email binding sends from `trakt-sync@gitman.net` to
`david@because.ventures`. It is disabled until account authorization and baseline
migration pass. The temporary Work-account deployment was removed.

## Validation

Use Node 24+ (native TypeScript stripping) and Python 3 for provisioning:

```sh
npm ci
npm test
npm run types
npm run typecheck
npm run dry-run
```

The tests use in-memory fixtures and a stub platform base class; they do not call live Trakt accounts. Deployment still requires live cloud verification.

## Provisioning

1. Authenticate Wrangler to the intended Cloudflare account. Prefer `npx wrangler login --device --use-keyring`.
2. Configure `wrangler.jsonc` email sender to a domain enabled for Cloudflare Email Sending. The destination is restricted to `david@because.ventures`.
3. Keep a random 32-byte base64 `ENCRYPTION_KEY` and a high-entropy `ADMIN_KEY` in 1Password. Never rotate the encryption key without migrating encrypted tokens.
4. Set `ADMIN_KEY_REF`, `ENCRYPTION_KEY_REF`, `TRAKT_CLIENT_ID_REF`, and `TRAKT_CLIENT_SECRET_REF` to their `op://` references. Run `python3 scripts/provision-secrets.py` to stream values to Wrangler without secret files or command-line arguments.
5. Run `npm run deploy`. The initial Durable Object is **disabled** even though the hourly cron is installed.
6. Set `SYNC_URL` to the deployed Worker HTTPS URL and retain `ADMIN_KEY_REF` for administration. `npm run admin -- status` returns safe operational state.
7. For each account, use `npm run admin -- auth/start '{"side":"david"}'` (then `emalie`), complete its device authorization in the correct account, then call `auth/poll` with the same body. Use dedicated grants, never copy desktop MCP refresh tokens.
8. Call `snapshot`, resolve the old verified baseline to typed numeric Trakt IDs, and call `initialize '{"baseline":["movie:123"]}'` with the **actual** baseline, not this example. Initialization requires both live lists to match. If they changed since the saved baseline, reconcile the migration deliberately before continuing.
9. Call `notifications/test` and verify the email arrived, then `dry-run`, `enable`, and `run`. Check `status` and both live lists. Verify a subsequent cloud cron run.

Cloudflare cron is `17 * * * *` (UTC). Routine successful runs send no email. Failed runs email the configured destination, deduplicated for 24 hours for an identical error; a successful run resets deduplication. If sending fails, the next failed sync retries it. Both errors are recorded in Cloudflare logs.

All administration requires a Bearer key over HTTPS. Valid operations are `status`, `snapshot`, `initialize`, `dry-run`, `enable`, `disable`, `run`, `auth/start`, `auth/poll`, and `notifications/test`. Tokens are never returned. Authorization headers must never be pasted into issue reports or logs.

## Recovery

`disable` prevents further scheduled syncs without deleting state. It waits behind an in-progress run. Inspect `status` and `snapshot`; preserve the pending journal until the conflict is understood. Do not replace the baseline with a union after a partial failure, since that can resurrect intentional removals.

If a refresh request was interrupted after Trakt might have rotated its token, the worker requires a fresh authorization for that account. It does not blindly reuse an uncertain refresh token. The other account and list state remain intact.

Deploying a new code version preserves Durable Object storage. Never delete the object or change its stable `davemalie` name to recover from a failure.
