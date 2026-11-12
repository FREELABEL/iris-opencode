---
category: Content & Media
level: intermediate
tags: [mixxx, dj, controllers, atlas, datasets, app-config]
duration_min: 10
---
# How to: Move a Mixxx rig to another Mac — with one command, or by hand

## What this does

A Mixxx setup that works is three things: the **controller mapping files**, the **mixxx.cfg
lines** that load them, and the **audio routing** (which device plays Master, which plays
Headphones). Two of those don't survive a copy. mixxx.cfg holds an absolute path, and
soundconfig.xml picks devices by `portAudioIndex`, a position in *that* Mac's device list. The
same routing is index 2 on one Mac and index 3 on the next.

So IRIS keeps a rig on an Atlas board as plain records you can read and edit with commands you
already have:

| What | Where | By hand |
|---|---|---|
| the bytes: every `controllers/` file | **bloq attachments**, checked by sha256 | `iris atlas files list / download / upload` |
| the settings: controllers + routes | **dataset `mixxx-rig`**, one row each, **the source of truth** | `iris datasets export / import / records list` |
| a readable copy | **page "Mixxx rig — <rig>"** (list *Rigs*), generated from the dataset | `iris atlas pull / diff / push` |

Audio routes are stored by **device name**, never by index. `apply` looks each name up on the Mac
it runs on.

## The one-command way

On the Mac that works (Mixxx can stay open; export only reads):

```bash
iris app-config export mixxx --bloq 569            # --rig <name> (default: this Mac's name)
```

It reuses an attachment that already holds the same bytes, and uploads (and reads back) anything
new. It upserts the dataset rows, removes this rig's rows that no longer exist, and regenerates
the page. Running it again changes nothing.

On the new Mac, open Mixxx once so it creates its profile, then:

```bash
iris app-config apply mixxx --bloq 569 --dry-run   # what would change, and which devices are here
iris app-config apply mixxx --bloq 569             # asks before quitting Mixxx; --quit-app to skip
```

Apply installs the mappings and checks their sha256. It takes a backup first. It merges only the
controller lines into mixxx.cfg, and only for a controller that is plugged in. Each audio route
gets *this* Mac's index for its device. Then it restarts Mixxx and reads `mixxx.log` until the
controller opens and the audio stream starts. A second run says `unchanged` and doesn't touch
Mixxx.

## The by-hand way

**Get the files.** The `controller_file` rows give each file's attachment id and sha256:

```bash
iris datasets records list -s mixxx-rig --bloq 569 --where kind=controller_file
iris atlas files download 569 --file 1290 --file 1291 --out ./controllers   # prints sha256 for each
```

Check that the printed sha256 matches the row's `mapping_sha256`. Then copy the files into Mixxx's
`controllers/` folder: `~/Library/Containers/org.mixxx.mixxx/Data/Library/Application
Support/Mixxx/controllers` if Mixxx is sandboxed, else `~/Library/Application Support/Mixxx/controllers`.

**Change a setting.** Export the rows, edit them, import them back. Import merges on
`external_id`, so nothing is duplicated:

```bash
iris datasets export -s mixxx-rig --bloq 569 --format json -o rig.json
# e.g. move Master to the controller: in "iris-hive-002/output/Master/0" set
#   "device_name": "PIONEER DDJ-T1", "channel": 0
iris datasets import rig.json -s mixxx-rig --bloq 569
```

The next `apply` uses the edited row. It also regenerates the page so the page matches.

**Or edit the page.** It holds the same rows in a fenced `json mixxx-rig` block:

```bash
iris atlas pull 569 ./rig-board
$EDITOR ./rig-board/rigs-*/mixxx-rig-iris-hive-002-*.md   # edit the block, not the tables
iris atlas diff ./rig-board && iris atlas push ./rig-board
```

The next `apply` sees that the page changed and the dataset didn't. It uses the page and copies
the change into the dataset.

## Rules worth knowing

- **Edit one side between applies, not both.** If the dataset and the page both changed since
  the page was generated, apply refuses and names the rows. Say which one wins with
  `--prefer dataset` or `--prefer page`.
- **Rows are keyed by route, not by device.** `iris-hive-002/output/Master/0` is "where Master
  goes". Moving Master to another device means editing that row's `device_name`, not adding a row.
- **A controller row's `cfg_key`** is the controller's MIDI name with spaces turned into `_`
  (`PIONEER DDJ-T1` → `PIONEER_DDJ-T1`). Leave it empty and fill `device_name`, and apply works
  it out.
- **Nothing is deleted on the board.** Older attachments with the same name stay. Rows point at
  the exact attachment id, and the sha256 decides.
- **Attachments, not the CDN.** Don't move mappings with `cloud:upload`, which gives public URLs.
  Bloq attachments stay as private as the board.

## Troubleshooting

| You see | It means |
|---|---|
| `controller PIONEER_DDJ-T1 is not connected` | Plug it in and run apply again. The mapping is installed but not enabled. |
| `audio device "…" is not connected` | That route wasn't written. The other routes were. |
| `the attachment's sha256 is …, the row says …` | The row points at different bytes than it names. Fix `mapping_file_id` or `mapping_sha256`. |
| `mixxx.log has not shown …` | Mixxx buffers its log. The setup is unconfirmed, not failed. Check Preferences › Controllers. |
| `no Mixxx profile at …` | Open Mixxx once, quit it, run again. |
