# How to: Authenticate the IRIS CLI (iris-login)

## What this does

Authenticates the user with the IRIS platform and writes credentials to `~/.iris/sdk/.env` so all `iris platform-*` commands and the Hive daemon can talk to the platform on the user's behalf.

## Prerequisites

- IRIS CLI installed (`which iris` should return `~/.iris/bin/iris` or a symlink)
- User has a heyiris.io account (sign up at https://heyiris.io if not)
- Network access to `app.heyiris.io`

## Steps (interactive)

```bash
$ iris-login
```

You'll be prompted for:

1. **Email** — the email on the heyiris.io account
2. **6-digit code** — sent to that email by the platform

On success, the command writes `~/.iris/sdk/.env` containing:

```
IRIS_SDK_TOKEN=<jwt>
IRIS_USER_ID=<uuid>
IRIS_API_URL=https://app.heyiris.io
```

## Steps (scripted / non-interactive)

If the user already has a token (e.g. from the heyiris.io dashboard or a previous session), they can pass it directly:

```bash
$ iris-login --token "<their-jwt>" --user-id "<their-uuid>"
```

This skips the email/code flow entirely and writes the same `.env` file.

## Expected output (success)

```
✓ Authenticated as user@example.com
✓ Wrote ~/.iris/sdk/.env
✓ Hive daemon registered (if installed)
Ready to go! Run `iris --help` to see commands.
```

The "Hive daemon registered" line only appears if the user has the daemon installed (see `hive-dispatch.md`). It's non-fatal if it fails.

## Verify it worked

```bash
$ cat ~/.iris/sdk/.env
# Should show IRIS_SDK_TOKEN=..., IRIS_USER_ID=..., IRIS_API_URL=...

$ iris platform-agents list
# Should return the user's agents (or an empty list, not an auth error)
```

## Common errors

### `Error: 401 Unauthorized` when running any `iris platform-*` command

**Cause:** `~/.iris/sdk/.env` is missing or has an expired token.
**Fix:** Re-run `iris-login`. If that fails, check `cat ~/.iris/sdk/.env` exists and has all three keys.

### `Error: ENOTFOUND app.heyiris.io` or `Error: connect ETIMEDOUT`

**Cause:** No network or the platform URL is wrong.
**Fix:** Check `curl -I https://app.heyiris.io` works. If the user is on a custom IRIS deployment, set `IRIS_API_URL` in `~/.iris/sdk/.env` to their endpoint.

### `Error: Email not found` after entering email

**Cause:** No heyiris.io account exists for that email.
**Fix:** Tell the user to sign up at https://heyiris.io first, then re-run `iris-login`.

### `Error: Invalid code` after entering the 6-digit code

**Cause:** Code expired (10-minute TTL) or typo.
**Fix:** Re-run `iris-login` and request a new code.

### Hive daemon error in output but `iris-login` itself succeeded

**Cause:** Daemon not installed or not running. This is non-fatal — auth still worked.
**Fix:** If the user wants Hive features, see `hive-dispatch.md`. Otherwise ignore.

## What `iris-login` does NOT do

- It does **not** install the Hive daemon — that's a separate component (see `hive-dispatch.md`)
- It does **not** create a heyiris.io account — user must sign up first
- It does **not** configure MCP servers — see `~/.iris/mcp.json` for that
- It does **not** affect the `iris-code` development repo if you have one cloned

## Related recipes

- `hive-dispatch.md` — once authed, connect a machine to the Hive
- `outreach-campaign.md` — first thing many users do after auth
- `lead-to-proposal.md` — Atlas OS workflow that requires auth
