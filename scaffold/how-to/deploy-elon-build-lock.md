# Recover the Elon frontend from a Railway build-lock race

**When to use:** a `fl-elon-web-ui` deploy shows `Deploy failed` and the build log
ends with:

```
[fatal] A lock with id 'build' already exists on /app/.nuxt
✖ Nuxt Fatal Error
```

This is a **build-lock race**, NOT a code error (bug #158427). It happens when two
Railway builds run at the same time and collide on the shared `.nuxt` cache lock —
usually because commits were pushed back-to-back, or someone triggered a redeploy
while a build was still running. Your code is almost certainly fine; a clean solo
build will pass.

## Background

- Railway is production. Deploy = `git push` to `master` (fl-api → `master`,
  fl-elon-web-ui → `master`). The `railway` CLI is installed + authed locally.
- The Nuxt `prebuild` step already does `rm -rf .nuxt .nuxt.lock; rm -f ./*.lock`,
  but that does NOT protect against a *concurrent* build creating the lock after
  your prebuild has run. Only-one-build-at-a-time is the real fix.
- **Stale status:** a Railway deployment often keeps showing `BUILDING` for minutes
  after it has actually finished. Check the build log — if it shows
  `image push` / `containerimage.digest`, the build is DONE and will flip to
  `SUCCESS` shortly (it is not hung).

## The one mistake that makes it worse

Do **NOT** trigger a new redeploy while another build is still in flight. Each new
build races the running one and fails on the lock, so you end up with a pile of
FAILED builds and the lock never clears. If you already did this, stop — just wait.

## Recovery procedure

1. **See every build's real state:**
   ```bash
   railway deployment list --service fl-elon-web-ui | head -6
   ```
   Note any row still `BUILDING`/`DEPLOYING`/`QUEUED`.

2. **Confirm a "stuck" build is actually done vs. genuinely running** (status lags):
   ```bash
   railway logs <deployment-id> --build --lines 12
   ```
   - Log ends with `image push` / `containerimage.digest` → it finished, will go
     `SUCCESS` on its own. Wait for it.
   - Log ends mid `nuxt build` (e.g. Babel lines) with no new output for many
     minutes → genuinely still building; still just wait.

3. **Wait until NOTHING is building** — every row is a terminal state
   (`SUCCESS` / `FAILED` / `REMOVED`). Do not touch anything until then.

4. **Trigger exactly ONE clean redeploy of the latest commit:**
   ```bash
   railway redeploy --service fl-elon-web-ui --from-source --yes
   ```
   `--from-source` builds the latest commit on `master` (not the failed image).
   With no other build running, it has a clean `.nuxt` lane and passes.

5. **Watch that single build to terminal:**
   ```bash
   railway deployment list --service fl-elon-web-ui | grep <new-id>
   ```
   Wait for `SUCCESS`, then verify the live site.

## Rule of thumb

One build at a time. If you pushed several commits quickly, don't chase each with a
redeploy — let the queue drain to all-terminal, then do a single `--from-source`
redeploy of the tip. Prod stays up on the last good deploy the whole time; a failed
build never takes the site down.

## Distinguish from the other common failure

- **Build-lock race** (this doc): `A lock with id 'build' already exists on /app/.nuxt`.
  Fix = wait for solo lane + one clean redeploy.
- **OOM**: `FATAL ERROR: ... JavaScript heap out of memory` / `Reached heap limit`.
  Different problem — needs a memory bump (`NODE_OPTIONS=--max-old-space-size=...`),
  not a redeploy.

## Handy commands

```bash
railway status                                             # all services at a glance
railway deployment list --service fl-elon-web-ui           # recent deploys + states
railway logs <id> --build --lines 40                       # a specific build's log
railway redeploy --service fl-elon-web-ui --from-source --yes   # clean rebuild of latest
```
