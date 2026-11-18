---
category: Data & Atlas
level: beginner
tags: [atlas, desktop, offline, cache, phi, sync, conflicts]
duration_min: 8
---
# How to: Open Atlas boards instantly, and keep working on them offline (IRIS Desktop)

IRIS Desktop keeps a copy of each Atlas board you open on your own machine. Boards draw at once from that copy, update from the cloud a moment later, and stay readable with no connection. A chip on every panel tab says whether what you see is current, and a refresh downloads only the cards that changed. Cards you edit, move or create with no connection are saved on your machine and sent when it returns; if someone changed the same thing meanwhile, you choose which to keep. It is **on by default**; boards holding patient data are **never copied** unless you say so.

Offline copy since **IRIS Desktop 1.18.143** (2026-10-22); the sync chip, instant tab switching and changed-cards-only refresh since **IRIS Desktop 1.18.145**; offline edits since **IRIS Desktop 1.18.150** (2026-10-23). macOS (Apple Silicon + Intel), Windows, Linux.

## Prerequisites
- IRIS Desktop **1.18.143 or later** to read offline, **1.18.150 or later** to edit offline (the app updates itself — restart when it asks)
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
| Offline · copy from 12m ago | IRIS could not be reached, so you are reading the last copy. | Keep working. Reconnect and click the chip. |
| Offline · 3 waiting | You are offline and 3 changes are saved on this machine, waiting to send. | Nothing. They send when IRIS can be reached. |
| 3 waiting · sending… | Connected again; the waiting changes are being sent. | Nothing. |
| 1 needs you | A change you made offline clashes with one made elsewhere. | Open the board and choose (see *When the same thing changed in two places*). |
| Couldn't update | IRIS answered without data (signed out, access refused). Hover for the reason. | Sign in again, or check your access. |

When a tab is *Offline*, *Couldn't update* or *needs you*, its name in the tab strip gets a small warning dot, so you can see it from any other tab.

Tabs that load their own data (Hive, Rooms…) show no chip.

The board list works the same way: offline you still see your boards and can open any you have opened before.

## Editing offline

With no connection you can still **edit a card** (title, description, status, priority, type, due date), **move it** to another list or position, and **create a new card**. Each change is saved on this machine at once:

- The card shows a **Waiting to send** badge, and the chip counts the changes: *Offline · 3 waiting*.
- A new card shows **new** where its number would be; it gets a real number once it reaches IRIS.
- When IRIS can be reached again, the changes are sent in the order you made them. This happens on its own: when the board next loads, every 20 seconds in the background, or straight away if you click the chip. The badges clear and the chip returns to *Synced*.

Several edits to one card while offline go as one change. Edits to a card you created offline go out with it.

A board with changes waiting is always kept on this machine, even past the board limit, until they are sent.

### When the same thing changed in two places

Every change remembers the version of the card it started from. When it is sent, IRIS checks whether the card changed since then.

- **Nobody else touched it** → your change lands.
- **Someone changed different fields** (you changed the title, they changed the status) → both are kept. Nothing to do.
- **Someone changed the same field** → nothing is overwritten. Fields that did not clash are sent; the clashing ones are held, the card's badge turns to **Needs you**, and the chip says *1 needs you*.

A panel at the top of the board shows each held card side by side:

| | Yours | Now on IRIS |
| --- | --- | --- |
| Status | done | in progress |

Choose **Keep mine** to send your value, or **Keep what's on IRIS** to drop yours. The message says who made the other change — or, if it was you on another device, says so.

If IRIS refuses a change outright (for example the board's owner removed your access while you were offline), the panel says why and offers **Dismiss**.

Waiting changes live in `~/.iris/atlas/outbox/<account id>.json` (owner only, like the copies).

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

A board marked as holding health information (`contains_phi`) is never written to disk by default. It always loads live, and offline it is not available — a copy on disk is not encrypted. The same rule covers offline edits: with the override off, an edit to a patient-data board made offline is refused with the reason, rather than saved to disk.

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

Offline you can read, edit, move and create cards. Some things still need a connection:

- **Search inside a board** (the copy holds card faces, not full text).
- **Labels, checklists, assignees, attachments and comments** cannot be changed offline yet.
- **Creating or renaming lists and boards.**
- **A board never opened** on this machine is not available offline, so it cannot be edited offline either.
- **Patient-data boards** are not available offline unless the override is on.
- **The `iris` CLI** does not queue offline edits yet; this is Desktop only.

| Problem | Fix |
| --- | --- |
| A board looks out of date | Wait for *Checking…* to clear, or click the chip. |
| *Offline* shows while you are online | IRIS could not reach the cloud. Check your connection, then click the chip. |
| *Couldn't update* | Hover the chip for the reason. Usually: sign in again. |
| *3 waiting* does not go down after reconnecting | Click the chip to send now. If a card says **Needs you**, choose in the panel; later changes to that card wait behind it. |
| An edit offline says the board isn't kept on this computer | You haven't opened that board on this machine while online, or it is a patient-data board with the override off. Reconnect to edit it. |
| You want everything gone from this machine | Turn *Keep a copy* off, or delete `~/.iris/atlas/cache`. Waiting changes in `~/.iris/atlas/outbox` are not sent if you delete that folder. |
| Disk use | Lower `maxBoards` or `maxMB` in the settings file. |
