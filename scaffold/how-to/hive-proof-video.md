---
category: Hive
level: beginner
tags: [hive, github, pull-request, video, review, proof, playwright, code]
duration_min: 5
---
# Show a change working, right on the pull request

A reviewer should not have to pull your branch to see whether the button works. One command
records the page in a headless browser, uploads the video to your IRIS files, and posts it as a
comment on the pull request — so the proof sits next to the code.

Hive coding tasks already do this on their own when they open a PR. This is the same recorder,
for when you want to do it by hand.

## 1. Check this machine is ready

```bash
iris hive proof --check
```

```
Ready to post proof videos from this machine.
  ✓ Recorder installed on this machine
  ✓ Browser  headless recorder ready
  ✓ Video    ffmpeg found — videos post as MP4
  ✓ GitHub   signed in as dana (your gh login)
  ✓ IRIS     signed in — videos upload to your IRIS files
```

Every ✗ line says what to run. The usual ones:

| Line | Fix |
|---|---|
| Recorder — not set up as a Hive node | `iris node install` |
| GitHub — not connected, or the login expired | `gh auth login` (or set `GITHUB_TOKEN`) |
| IRIS — not signed in | `iris login` |

No ffmpeg is fine: the video posts as WebM, which plays in Chrome and Firefox.

## 2. Record and post

Start your app, then point the recorder at the page you changed:

```bash
iris hive proof http://localhost:3000/checkout --pr acme/shop#128
```

Inside the repo's folder you can give just the number: `--pr 128`.

```
✓ Video posted on acme/shop#128
  Comment: https://github.com/acme/shop/pull/128#issuecomment-…
  Video:   https://cdn.heyiris.io/cloud-files/…mp4
```

## 3. Walk through a flow, not just a page

Put the clicks and typing in a small JSON file:

```json
[
  { "action": "fill",  "selector": "#email", "value": "dana@example.com" },
  { "action": "click", "selector": "#buy" },
  { "action": "wait",  "ms": 1000 }
]
```

```bash
iris hive proof http://localhost:3000/checkout --pr 128 --steps flow.json --note "Fixes the buy button"
```

Actions: `click`, `fill`, `goto`, `press`, `hover`, `scroll`, `wait`. The steps are listed under the video
in the comment, so the reviewer knows what they are watching.

## Try it without posting

```bash
iris hive proof http://localhost:3000 --dry-run
```

Records and uploads, prints the comment it would post, posts nothing.

## What to know

- **One comment per run.** It never polls the PR. If GitHub is rate-limiting your login, it says
  when the limit resets and stops.
- **Your GitHub login, not ours.** It uses `GITHUB_TOKEN` / `GH_TOKEN`, or your own `gh` login.
- **Turn it off for a Hive task** with the task config `{"proof_video": false}`.
- **Tasks that hold patient data never upload a video.** Those recordings stay on the machine.
- `iris hive proof --check --json` and `iris hive proof … --json` print one JSON object, for scripts.
