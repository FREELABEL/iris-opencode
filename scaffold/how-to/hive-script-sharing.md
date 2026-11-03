---
category: Infrastructure
level: intermediate
tags: [hive, scripts, sharing, boards, bloq, publish, marketplace, runs-on, versions]
duration_min: 10
---
# How to: Share a Hive script with your team

## The one-paragraph version

You write a script once, `push` it, and share it with a **board** (a bloq). Everyone on that
board then sees it in `iris scripts list --shared` and runs it by name with
`iris scripts run <slug>`. They don't need a copy, a uuid, or to know which machine it belongs on.
A `# iris: runs-on=` line at the top of the script says where it runs. Each push that changes the
file makes a new version, and anyone can pin one with `@N`. When you want a wider audience, the
same script can go to anyone with the link (`unlisted`) or to the public Hive marketplace
(`public`).

## Prerequisites

- Signed in: `iris login` (CLI **v1.5.33 or newer** — `iris --version`; `iris update` if older)
- At least one machine on Hive: `iris hive nodes list` (see `hive-dispatch.md`)
- A board your teammates are on. `iris bloqs list` shows your boards and their ids, and
  `iris bloq-members list <bloq>` shows who is on one (see `bloq-access-control.md`)

## Step 1: Say where it runs, then push it

Put the directives in the first comment block of the file. Use `#` for bash and Python, and `//`
for JavaScript and TypeScript:

```bash
#!/bin/bash
# Resize every photo in ~/Pictures/inbox to 1600px.
# iris: runs-on=studio-mac
# iris: timeout=300
sips -Z 1600 ~/Pictures/inbox/*.jpg
```

`runs-on` takes one of three forms:

| Value | Means |
|---|---|
| `runs-on=studio-mac` | only that machine. It is never swapped for another one, even if that one is offline |
| `runs-on=capability:gpu` | any machine that advertises the capability |
| `runs-on=any` | any machine that can take it |

```
$ iris scripts push photo-resize ./photo-resize.sh
✓ Created photo-resize [bash]
$ iris scripts doctor photo-resize        # which machines can run it, and what each is missing
```

A bad directive is reported by name (`runs-on must be any, a node name or capability:<name>`),
and a script with manifest errors cannot be published. Fix the line and push again.

## Step 2: Share it with a board

```
$ iris scripts share photo-resize --bloq 12

  ✓ photo-resize is shared with board #12 — now project
  Signed-in members of board #12 only
  Members find it with: iris scripts list --shared
  and run it with:      iris scripts run photo-resize
```

`publish --scope project` does the same thing, and takes several boards in one call:

```
$ iris scripts publish photo-resize --scope project --bloq 12 --bloq 40
```

You can only share to boards you own or belong to. Neither command asks for confirmation,
because a board's members are a known, bounded audience.

## Step 3: Your teammate finds it and runs it

```
$ iris scripts list --shared

Shared with you
  photo-resize  [bash]  v3 · project · board #12 · runs-on studio-mac  · by Ana Ruiz
    run: iris scripts run photo-resize

$ iris scripts run photo-resize
→ running Ana Ruiz's photo-resize v3 (3f2a1c9e-…)
→ dispatching photo-resize to runs-on studio-mac (routed by the server)
```

Each row's `run:` line is the shortest command that names that one script, so it can be copied
and run as is:

- **The bare slug** is shown when nobody else shared a script by that name and the teammate has
  none of their own.
- **`author/slug`** is shown when two people shared a `photo-resize`, or the teammate has their
  own. For example: `iris scripts run "Ana Ruiz/photo-resize"`, or
  `iris scripts run photo-resize --from ana`. The author is matched case-insensitively.
- **The uuid** is shown when even the author doesn't tell them apart.

**Your own script always wins.** If the teammate has a `photo-resize` of their own, the plain
slug runs theirs. A share never changes what someone's existing command runs.

## Versions

Every push that changes the content makes a new, immutable version. A push with nothing
changed does not. `iris scripts run photo-resize` runs the current version, and
`iris scripts run photo-resize@2` runs version 2 exactly. The server pins the version and signs
its content hash, and the machine runs exactly that version or refuses.

## Unlisted vs public

| Scope | Who can open it | Asks first? |
|---|---|---|
| `project` | signed-in members of the boards you named | no |
| `unlisted` | anyone with the link. It appears in no listing | no |
| `public` | anyone. It is listed in the Hive marketplace at heyiris.io/p/hive-scripts | **yes**. With no terminal (an agent or CI) it needs `--force`, and is refused without it |

```
$ iris scripts publish photo-resize --scope unlisted
$ iris scripts publish photo-resize --scope public
```

There is no `--scope private`. To make a script private, unpublish it (below).

## Taking it back

```
$ iris scripts unshare photo-resize --bloq 12   # remove one board
$ iris scripts unpublish photo-resize           # private again: off the marketplace, every board, every link
```

Removing the last board from a `project` script makes it private. **Neither command un-sends
anything.** Anyone who already ran the script has had its source on their machine, so change
anything that matters, like credentials, ids and internal names, instead of relying on
unsharing.

## What members can see

- **The source.** Running a script sends its full source to the machine it runs on. If that is
  a teammate's machine, they have your code. Share only what you'd hand them in a file.
- **Your machine, only if the board shares it.** `runs-on=<your-machine>` runs on your machine
  only when that board also shares the machine with them. Otherwise the run is refused with
  "…runs only on studio-mac, and that machine is not one you can reach."
- **Not your other scripts.** They see only what you shared with a board they are on, and never
  your private scripts or ones you shared with other boards.
- **Who wrote it.** The name on your account when you first published is shown as the author.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `N people shared a script called 'x' with you — say whose` | two authors share the same slug | copy one of the listed commands, or add `--from <author>` |
| `Nobody called 'ana' has shared 'x' with a board you belong to` | the author name doesn't match, or you aren't on the board | `iris scripts list --shared` shows the exact author names |
| `--bloq <id> is required when --scope project` | a project script must name a board | add `--bloq <id>` (`iris bloqs list`) |
| `Refusing to make 'x' public without consent` | public publish with no terminal | rerun at a terminal, or pass `--force` if you mean it |
| `This script has manifest errors and cannot be published` | a `# iris:` line didn't parse | `iris scripts doctor <slug>`, fix the line, push |
| `'x' runs only on studio-mac, and that machine is not one you can reach` | the runs-on machine isn't shared with the person running it | share the machine with the board, or use `runs-on=capability:<x>` / `any` |

## Run it as a playbook

The share-and-run path, with the sending steps behind confirmation, is the `hive-script-share`
playbook:

```
$ iris playbook run hive-script-share --slug photo-resize --file ./photo-resize.sh --bloq 12
```

## Related recipes

- `hive-dispatch.md`: connect a machine to Hive
- `bloq-access-control.md`: who is on a board, invites and revoking access
- `hive-tailscale.md`: reaching a machine that isn't on your network
