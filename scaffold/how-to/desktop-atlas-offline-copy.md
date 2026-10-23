---
category: Data & Atlas
level: beginner
tags: [atlas, desktop, offline, cache, phi, sync]
duration_min: 5
---
# How to: Open Atlas boards instantly and read them offline (IRIS Desktop)

IRIS Desktop keeps a copy of each Atlas board you open on your own machine. Boards draw at once from that copy, update from the cloud a moment later, and stay readable with no connection. A chip on every panel tab says whether what you see is current, and a refresh downloads only the cards that changed. It is **on by default**; boards holding patient data are **never copied** unless you say so.

Offline copy since **IRIS Desktop 1.18.143** (2026-10-22); the sync chip, instant tab switching and changed-cards-only refresh since **IRIS Desktop 1.18.145**. macOS (Apple Silicon + Intel), Windows, Linux.

## Prerequisites
- IRIS Desktop **1.18.143 or later** (the app updates itself — restart when it asks)
- Signed in to IRIS

Looking for an offline copy of a **dataset** you can edit from the CLI? That is a different feature: see `atlas-local-copy.md`.

## At a glance — where a board comes from

1. **You open a board.**
2. **Is there a copy on this machine?**
   - **Yes** → the board is drawn from the copy at once (chip: *Checking…*), and the cloud is asked what changed since that copy.
   - **No** → the cloud is asked directly.
3. **The cloud answers one of three ways:**
   - **Answer arrives** → only the cards that changed are downloaded, the copy is updated, and the chip turns to *Synced*. Nothing changed means almost nothing is downloaded.
   - **Cloud says no** (board deleted, access removed, signed out) → the copy is **deleted**, not shown.
   - **Cloud unreachable** → the copy is shown and the chip says *Offline*.

A search inside a board always goes to the cloud.

Switching panel tabs keeps what each tab last showed. Go from Atlas to Agents and back, and the board is on screen at once while it checks for changes behind it.

## What you see

A chip in the row under the tab name says whether what is on screen is current. Click it to check again.

| Chip | What it means | What to do |
| --- | --- | --- |
| Checking… | Showing what this tab last had (or the board's copy) while IRIS is asked for what is current. Usually clears in under a second. | Nothing. |
| Synced · 5m ago | This is what IRIS returned, at that time. The open board is also checked for changes every 10 seconds. | Nothing. |
| Offline · copy from 12m ago | IRIS could not be reached, so you are reading the last copy. | Read freely. Reconnect and click the chip. |
| Couldn't update | IRIS answered without data (signed out, access refused). Hover for the reason. | Sign in again, or check your access. |

When a tab is *Offline* or *Couldn't update*, its name in the tab strip gets a small warning dot, so you can see it from any other tab.

Tabs that load their own data (Hive, Rooms…) show no chip.

The board list works the same way: offline you still see your boards and can open any you have opened before.

## Turning it on or off

In the Atlas tab, click the **disk icon** in the toolbar to open **Offline copy**. Each switch saves the moment it flips.

- **Keep a copy of Atlas on this machine** (on by default). Turning it off deletes every copy straight away.
- **Include boards marked as holding health information** (off by default). See below.

The same settings live in `~/.iris/atlas/local-copy.json`, so the CLI or an admin can set them without the app:

```json
{
  "enabled": true,
  "includePhi": false,
  "maxBoards": 20,
  "maxMB": 200
}
```

A field left out or invalid falls back to its default, never to "off for everything".

## Patient-data boards

A board marked as holding health information (`contains_phi`) is never written to disk by default. It always loads live, and offline it is not available — a copy on disk is not encrypted.

- **Default:** not copied.
- **Override:** switch on *Include boards marked as holding health information*, or set `"includePhi": true`. Only on an encrypted, single-user machine.
- **Switching it back off** deletes those copies at once.
- **A board marked later:** its old copy is deleted the next time it is read, never shown.

Per machine today; built so a per-board or per-organisation rule can be added later without a release.

## What is kept and where

| Item | Detail |
| --- | --- |
| Location | `~/.iris/atlas/cache/<account id>/<board id>.json`, plus `_boards.json` for the board list |
| What a copy holds | What the board shows: titles, statuses, card faces, previews. Not full card text. |
| Size | About 1 MB for the largest board measured |
| Limits | The 20 most recently opened boards, up to 200 MB, per account. Oldest go first. Configurable. |
| Permissions | Owner only (folders 0700, files 0600). Written safely so a crash never leaves a half file. |
| Accounts | Each signed-in account has its own folder. |
| Access removed | If the cloud says no, the copy is deleted. Only "could not reach the cloud" falls back to the copy. |

## Offline limits and troubleshooting

Offline you can read; you cannot change anything yet.

- **Search inside a board** needs a connection (the copy holds card faces, not full text).
- **Editing, moving or creating cards** needs a connection. Offline edits are planned (phase 4).
- **A board never opened** on this machine is not available offline.
- **Patient-data boards** are not available offline unless the override is on.

| Problem | Fix |
| --- | --- |
| A board looks out of date | Wait for *Checking…* to clear, or click the chip. |
| *Offline* shows while you are online | IRIS could not reach the cloud. Check your connection, then click the chip. |
| *Couldn't update* | Hover the chip for the reason. Usually: sign in again. |
| You want everything gone from this machine | Turn *Keep a copy* off, or delete `~/.iris/atlas/cache`. |
| Disk use | Lower `maxBoards` or `maxMB` in the settings file. |
