---
category: Data & Atlas
level: intermediate
tags: [atlas, datasets, sync, offline, daemon]
duration_min: 10
---
# How to: Keep a local copy of an Atlas dataset in step with the cloud

## What It Does

Keeps a copy of an Atlas dataset on your own computer as plain files you can open, edit and
script against — offline if you like — and keeps it in step with the cloud in both directions.

- **Edit locally**, and your changes go up the next time it syncs.
- **Records change in the cloud**, and they come down without overwriting what you changed.
- **Both sides change the same record?** Different fields merge on their own. The same field
  changed two ways keeps *your* value and tells you, so nothing is lost silently.
- **Turn on background sync** and the IRIS daemon on that machine does it every 5 minutes.

## Recipe

### 1. Make a local copy

```bash
iris atlas:datasets pull <dataset>
```

It lands in `~/.iris/atlas/datasets/<dataset>/`:

```
schema.json            the dataset's fields
records/<id>.json      one file per record — edit the "data" part freely
```

### 2. Change things

- Edit `records/<id>.json`.
- Add a record: create `records/new-anything.json` containing `{"data": {...}}`.
- See where every record stands, offline: `iris atlas:datasets status <dataset>`

### 3. Send your changes

```bash
iris atlas:datasets push <dataset>
```

New records are created; edits are sent. If a record changed in the cloud since your copy, that
edit is held back with a message — run `pull` (it merges), then `push` again.

Deleting a file does **not** delete the record in the cloud. To delete records whose files you
removed: `iris atlas:datasets push <dataset> --prune`.

### 4. Or let it run by itself

```bash
iris atlas:datasets sync <dataset> --background on
```

`sync` is pull then push. With `--background on`, the IRIS daemon on this machine runs it every
5 minutes. Turn it off with `--background off`.

## When both sides changed the same field

`pull` keeps your value, names the field, and holds that record back from `push`:

```
record 12: both sides changed note — your value kept; edit records/12.json, then run
`iris atlas:datasets resolve <dataset> 12`
```

Open the file, make it say what it should, then run `resolve` and `push`.

## Good to know

- Records written on your machine are marked as coming from it, so you can tell later where a
  record was created.
- A record's status (active, archived) follows the cloud; you edit its data.
- Requires IRIS CLI 1.5.3 or newer (`iris update`), and for background sync the IRIS daemon
  running on that machine.
