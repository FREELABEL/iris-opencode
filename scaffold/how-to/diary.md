# How to: Daily diary — publish local markdown into your IRIS diary

## What this does
Keep a per-day diary inside IRIS, scoped to you (or an agent, or a project bloq), and
**publish your local `daily-diary/*.md` files into it** with one command. Entries are private
by default and readable by you and your agents; any single entry can be made publicly shareable.

The diary lives server-side as `BloqItem` rows (`type='diary'`) under a per-scope "Daily Diary"
bloq. There are two halves people confuse:
- **Local `daily-diary/*.md`** — git-committed working notes on your machine. Source only.
- **IRIS diary** (`/api/v6/diary`) — the durable, account-scoped record. `iris diary sync`
  bridges the first into the second.

## Prerequisites
- IRIS CLI authenticated (`iris login`) — identity comes from your Bearer token.
- CLI ≥ v1.3.111 (`iris diary sync` ships there). Check `iris --version`; update with `iris upgrade`.

## Read / write your diary
```bash
$ iris diary today                 # today's timeline (default scope = your "My Diary")
$ iris diary list --days 14        # recent entries
$ iris diary view 2026-06-28       # one day
$ iris diary add "shipped X"       # append a timestamped section to today
```
Scope flags work on every subcommand:
```bash
$ iris diary today --agent 11      # an agent's diary (you must own the agent)
$ iris diary today --bloq 325      # a project bloq's diary (you must own the bloq)
```

## Publish local markdown files (the main recipe)
```bash
$ iris diary sync daily-diary/2026-06-28-my-notes.md   # one file
$ iris diary sync daily-diary/                          # a whole directory of *.md
```
What it does:
- **Date** comes from frontmatter `date:` or a `YYYY-MM-DD` filename prefix (one entry per day).
- **Idempotent** — it POSTs `replace:true`, so re-running updates the same entry instead of
  duplicating. On first sync it writes `iris_diary_item_id: <id>` back into the file's frontmatter;
  that anchor is how re-runs find the same entry. First run prints `✓ new`, later runs `✓ updated`.
- **Scope** — default is your private "My Diary"; add `--bloq <id>` or `--agent <id>` to target
  those (you must own them, else 404).

## Make an entry publicly shareable (opt-in)
Private by default. To share a single entry, reuse the bloq share-link mechanism:
```bash
$ iris diary sync daily-diary/2026-06-28-my-notes.md --public
$ iris diary sync daily-diary/2026-06-28-my-notes.md --public --expires 30d
$ iris diary sync daily-diary/2026-06-28-my-notes.md --public --password hunter2
```
This calls fl-api `make-public` and the entry becomes readable at `GET /bloq/item/{uuid}` (the
public URL is written back to frontmatter as `iris_diary_public_url`).

## Security model (why a bare URL won't leak it)
`/api/v6/diary` is gated by `auth.platform` — no Bearer token → **401**. Your user_id is resolved
from the token, not from a request param; a spoofed `?user_id=` that doesn't match your token →
**403**. Agent/bloq scopes are owner-only → **404** if you don't own them. So the diary is private
to its scope; only `--public` entries are reachable without auth.

## Auto-publish each session (optional)
Pair it with the daily-diary habit so each session's entry lands in your IRIS diary automatically:
```bash
$ iris diary sync daily-diary/$(date +%F)-*.md
```
(Drop that line into the repo's Stop hook to do it without thinking about it.)

## Gotchas
- `iris diary sync` needs auth — run `iris login` first; identity is the token, not a flag.
- One entry **per date** per scope. Two files with the same date sync to the same entry (last wins).
- Re-running is safe (idempotent) — that's the point; don't worry about duplicates.
- The local `daily-diary/*.md` files stay in git; sync copies their content up, it doesn't move them.
