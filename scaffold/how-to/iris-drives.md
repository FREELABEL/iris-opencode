---
category: Data & Atlas
level: beginner
tags: [drives, backup, hard drive, flash drive, ssd, footage, find a file, find a file on a drive, which drive has, encryption, bitlocker, veracrypt, sd card, duplicates, copies, checksum, audit, windows, full disk access]
duration_min: 15
---
# How to: Know what is on every drive you own, and find any file without plugging it in

## What this does

`iris drives` catalogs a hard drive, SSD, flash drive or folder from your own Mac or PC. Afterwards
you can search every drive you have cataloged from any computer you sign in to, with the drives in
a drawer. It also lists the database dumps, passwords and key files sitting on a drive that is not
encrypted, so you find them before a lost drive turns into a breach.

Your files never leave the drive. IRIS reads names, sizes and dates. The full list of files is
encrypted on your computer before it is saved to your account, and folders you mark private are
never opened.

Two rules explain everything else in this guide:

- **Atlas holds the catalog; the drive keeps the bytes.** Searching, listing and counting copies
  read the catalog, so they work with the drive unplugged.
- **A path is only valid where the drive is plugged in.** `path` and `get` work only on the computer
  the drive is connected to right now, and they say so plainly when it is not.

Product page: [heyiris.io/p/drives](https://heyiris.io/p/drives) · Guided playbook:
[heyiris.io/playbooks/iris-drives](https://heyiris.io/playbooks/iris-drives)

## The six commands at a glance

| Command | What it answers | Needs the drive plugged in? |
|---|---|---|
| `iris drives scan <drive>` | Catalog this drive (or rescan it after it changes) | Yes |
| `iris drives list` | Which drives do I have, which are encrypted, which hold sensitive files? | No |
| `iris drives find <words>` | Which drive has this file? | No |
| `iris drives copies <words>` | How many identical copies of this file exist, and where? | No |
| `iris drives path <drive>:<path>` | Where is that file on this computer right now? | Yes, here |
| `iris drives get <drive>:<path>` | Copy one file off the drive, with a recorded reason | Yes, here |

Every command has examples in its own help: `iris drives scan --help`, `iris drives get --help`.

## Your first 10 minutes

1. `iris update`, then `iris drives --help`. You should see all six commands above.
2. Plug the drive in. On a Mac, `ls /Volumes` shows its name; on Windows, note its letter in File
   Explorer (for example `E:`).
3. Decide which folders on it are private (family photos, your own medical or tax papers).
4. Look before you save anything:
   `iris drives scan /Volumes/Footage --exclude Personal --dry-run`
5. Catalog it: `iris drives scan /Volumes/Footage --exclude Personal`
6. `iris drives list`: the drive is there. If it says **NOT encrypted** and has sensitive files,
   read Step 6.
7. Unplug the drive, then `iris drives find <a word from a file name you know>`. It still finds it.
   That is the whole point.
8. Plug it back in and `iris drives path "<drive>:<path find showed>"` prints the real path.

Repeat steps 4 and 5 for each drive you own. Each one takes a few minutes; a large footage drive
takes longer the first time.

## Before you start

- IRIS installed and signed in (`iris auth login`).
- The drive plugged in. On a Mac it shows up under `/Volumes` (`ls /Volumes`); on Windows it has a
  letter such as `E:\`.
- On a Mac, give your terminal app **Full Disk Access** (System Settings → Privacy & Security →
  Full Disk Access), or some folders cannot be read.
- A minute to decide which folders on the drive are nobody's business (family photos, your own
  medical or tax papers). Those get marked private in Step 2.

## Step 1: Update IRIS

```bash
iris update
iris drives --help
```

All six commands (`scan`, `find`, `path`, `list`, `copies`, `get`) need IRIS 1.5.46 or newer.
Versions 1.5.43 to 1.5.45 have only `scan`, `find`, `path` and `list`; if `copies` or `get` is
missing from `iris drives --help`, run `iris update` again.

## Step 2: Catalog the drive (`scan`)

Name the private folders with `--exclude`, one per folder, relative to the drive. They are skipped
before they are opened: nothing inside them is listed, counted or read. The list is remembered on
the drive's card in your account, so every later scan of this drive, from any computer, skips them
too.

To see what a scan finds before anything is saved, add `--dry-run`:

```bash
iris drives scan /Volumes/Footage --label "Studio footage" --exclude Personal --dry-run
```

```
Scanning Studio footage (/Volumes/Footage)
  Private folders skipped, never opened: 1
  Mostly: video 1,842 · audio 212 · project 38 · db-dump 1 · credential 1
Dry run — nothing was sent to your account. Would catalog 'Studio footage': 2,106 files · 1.4 TB · 41 project folders · 2 sensitive files (drive NOT encrypted)
```

**What it means:** one private folder was skipped unopened; the drive is mostly video; two files
look like a database dump and a password or key file, and because the drive is not encrypted,
anyone who picks it up could read them. Nothing was saved.

Then catalog it for real:

```bash
iris drives scan /Volumes/Footage --label "Studio footage" --exclude Personal
```

```
Scanning Studio footage (/Volumes/Footage)
  Private folders skipped, never opened: 1
  Mostly: video 1,842 · audio 212 · project 38 · db-dump 1 · credential 1
Cataloged 'Studio footage': 2,106 files · 1.4 TB · 41 project folders · 2 sensitive files (drive NOT encrypted — run: iris drives list to review)
```

The first scan sets up a **Drives** board in your Atlas. A rescan of the same drive replaces its
catalog; it never makes a second copy of the drive. On an encrypted drive the last line ends
`(drive encrypted — contained)` instead.

Other drives:

- Windows: `iris drives scan E:\` (see [Windows drive letters](#windows-drive-letters) below)
- A folder on your computer: `iris drives scan ~/Projects --label "Client projects" --kind archive-folder`
- A backup drive: `iris drives scan /Volumes/Backup2 --label "Backup 2" --kind backup-drive`
- Give a drive a name you would say out loud: `--label "Studio footage 2025"`. That name is what
  you type in `path` and `get`.
- `--verbose` also prints the drive's id and each save to your account.

While it scans, IRIS also takes a fingerprint (a SHA-256 checksum) of the small files that matter
most: every sensitive file, and project, document and audio files up to 64 MB. That is what lets
`copies` (Step 5b) tell two identical files from two different files with the same name. Video and
large files are skipped by default because fingerprinting reads every byte, which takes hours on a
big drive over USB. To fingerprint everything, add `--checksums all`; to skip it, `--checksums none`.
Files inside a private folder are never fingerprinted, because they are never opened.

## Step 3: See all your drives (`list`)

```bash
iris drives list
```

```
Backup 2                       429 files      13.4 GB  encrypted       12 sensitive    49.1 GB free  offline  scanned 2026-11-09 · last seen on studio-mac
Studio footage               2,106 files    1420.5 GB  NOT encrypted    2 sensitive   579.0 GB free  online  scanned 2026-11-12 · last seen on studio-mac
Client projects             21,025 files      13.4 GB  NOT encrypted    0 sensitive   402.7 GB free  offline  scanned 2026-11-02 · last seen on laptop
```

**What it means:** `online` means the drive is plugged into this computer right now; `offline` means
it is not (it is still searchable). Free space and "last seen on" are as of the drive's last scan.
**Backup 2** is fine: its sensitive files are on an encrypted drive. **Studio footage** is the one to
fix first (Step 6): sensitive files on a drive anyone could read. **Client projects** has nothing
sensitive, so not being encrypted matters less.

## Step 4: Find a file on any drive (`find`)

```bash
iris drives find proxy mov --limit 2
```

```
Studio footage · connected to this computer
  Shoots/2025-01-17/Proxies/A001_0145_Proxy.mov  · 0.03 GB · video · 2025-01-21
  Shoots/2025-01-17/Proxies/A002_0031_Proxy.mov  · 0.02 GB · video · 2025-01-21
  … and 1196 more on Studio footage

Backup 2 · not connected here — found from its catalog
  Archive/2024/Proxies/B001_0007_Proxy.mov  · 0.04 GB · video · 2024-06-02 · 2 identical copies

Where a file is on this computer right now: iris drives path <drive>:<path>   (iris drives list shows each drive)
```

**What it means:** every word has to appear somewhere in the file's path (any order, any case). The
search reads your catalog, so it works with the drive unplugged. `· 2 identical copies` means the
same file, byte for byte, exists twice across your drives (see Step 5b). `--limit 50` shows more
matches per drive. If nothing matches you see `Nothing found on any cataloged drive.`

## Step 5: Get the real path, if the drive is plugged in here (`path`)

Use the drive's name from `iris drives list`, a colon, and the path `find` showed:

```bash
iris drives path "Studio footage:Shoots/2025-01-17/Proxies/A001_0145_Proxy.mov"
```

```
/Volumes/Footage/Shoots/2025-01-17/Proxies/A001_0145_Proxy.mov
```

It never guesses. When the answer is "not here", it says so and exits with a code a script can check:

```bash
iris drives path "Backup 2:Archive/2024/Proxies/B001_0007_Proxy.mov"; echo "exit=$?"
```

```
Not a valid path right now: Backup 2 is not connected to this computer
exit=2
```

```bash
iris drives path "Studio footage:Old/renamed-since.mov"; echo "exit=$?"
```

```
Studio footage is connected at /Volumes/Footage, but Old/renamed-since.mov is not there (moved or deleted since the last scan)
exit=3
```

| Exit code | Means | Do |
|---|---|---|
| 0 | Printed the full path | Use it |
| 2 | The drive is not plugged into this computer | Plug it in here, or run the command on the computer it is plugged into |
| 3 | The drive is here, but the file has moved or been deleted since the last scan | Rescan the drive, then `find` it again |

## Step 5b: Count the copies of a file (`copies`)

Before you delete anything, or to check a backup really happened, ask how many copies exist:

```bash
iris drives copies final mix
```

```
final mix.wav — 3 identical copies on: Backup 2, Studio footage
  Backup 2: Archive/final mix.wav
  Studio footage: Mixes/final mix.wav
  Studio footage: Old/final mix (2).wav
brief.pdf — same name, different content: 2 versions
  version 1 (sha256 3fa1c09b2e44…): 1 copy
    Client projects: Acme/brief.pdf
  version 2 (sha256 9d0e27aa61c3…): 1 copy
    Studio footage: Acme/brief.pdf
Not checksummed yet: 1 file — scan the drive with --checksums all to compare them
  Studio footage: Shoots/final mix proxy.mov
```

**What it means:** copies are matched by their fingerprint, not their name, so a renamed copy still
counts (`final mix (2).wav`) and two files that only share a name are shown as different versions
(`brief.pdf`: decide which one is current before deleting either). A file with no fingerprint yet (a
video, or a drive scanned before fingerprints existed) is listed as *not checksummed yet*: scan that
drive again, with `--checksums all` for videos.

## Step 5c: Copy one file off a drive, on the record (`get`)

```bash
iris drives get "Client projects:Acme/brief.pdf" --to ~/Desktop --why "send the brief to the client"
```

```
Copied Acme/brief.pdf from Client projects → /Users/you/Desktop/brief.pdf
  under 1 MB · sha256 3fa1c09b2e44d0a7… verified · recorded in your Drives board (Drive reads)
```

**What it means:** the copy was checked against the original, and a row was added to the **Drive
reads** list on your Drives board: who read it, from which computer, when, why, and its fingerprint.

- The drive has to be plugged into this computer; if it is not, `get` says so and exits with code 2,
  like `path`.
- `--why` is required. Without it: `--why is required: say why you are reading this file`.
- If the copy does not match the original, the copy is deleted and nothing is recorded. If the
  record cannot be saved, the copy is deleted too.
- A file inside a private folder is refused; private folders are never opened.
- A sensitive file (passwords, keys, database dumps) needs `--confirm`:

  ```bash
  iris drives get "Client projects:old-site/app/.env" --to ~/secure --why "rotate the key"
  ```

  ```
  old-site/app/.env is a sensitive file (credential) on Client projects, and that drive is NOT encrypted.
  Copying it puts a second copy on this computer. If you mean to, add --confirm. The read is recorded either way.
  ```

  Add `--confirm` only if you really want a second copy of it on this computer.
- One file at a time. A project bundle such as a `.logicx` arrives as one `.zip`.
- `get` never overwrites: if the file already exists in `--to`, pick another folder.
- `get` never unlocks an encrypted drive. Unlock it the usual way first (Finder, BitLocker,
  VeraCrypt), then run `get`.

## Step 6: Encrypt a drive that holds sensitive files

A sensitive file on an unencrypted drive can be read by whoever picks the drive up. Encrypt the
whole drive, picking the method by where the drive has to open:

- **Mac only:** in Finder, right-click the drive → **Encrypt**. An older Mac-format drive first needs
  Disk Utility → Convert to APFS.
- **Windows only:** right-click the drive → **Turn on BitLocker** (Windows Pro is needed to set it up).
- **Mac and Windows:** **VeraCrypt** (free) makes one encrypted volume both can open.

Keep two ways in: the password you type, and a recovery key saved in your password manager. Then
scan the drive again: its sensitive files show as *contained*.

An encrypted disk image (`.dmg`) on an unencrypted drive protects the files inside the image, not
the drive, so the drive is still listed as NOT encrypted.

For a few old files on a big drive, moving just those is quicker: copy them to an encrypted drive,
compare checksums (`shasum -a 256` on a Mac), and only then delete the originals. Never delete first.
A rescan marks the files that are gone as *moved*.

## Camera and SD cards: two copies before formatting

Cameras cannot record to an encrypted card, so keep a card's life short:

1. Copy the card to a drive and check every file.
2. Make a second copy on an **encrypted** drive and check it.
3. Scan that drive, then `iris drives find <a clip name>` should show the clip in two places
   (`iris drives copies <a clip name>` says how many identical copies, once fingerprinted with
   `--checksums all`).
4. Only then format the card, in the camera.

If the search does not show the footage in two places, the card is not ready to format.

## Privacy: what is stored, and what is encrypted

| What | Where | Readable by |
|---|---|---|
| The drive's card: name, size, free space, encrypted or not, file and folder counts, computer last seen on, last scan | Your Drives board in Atlas | You, and anyone you share the board with |
| One row per project folder (path, file count, size, main kind) | Your Drives board | Same |
| One row per sensitive file (path, kind, size, *exposed*/*contained*/*moved*) | Your Drives board | Same. File contents are never read or stored |
| The full list of every file (path, size, date, kind, fingerprint) | One file per drive, **encrypted on your computer with AES-256-GCM** (a fresh key every scan) before upload | Only through your account: the key is kept in a private field on the drive's card |
| Private folders | Only the folder names you passed to `--exclude`, on the drive's card, so other computers skip them too | Nothing inside is ever opened, listed, counted or fingerprinted |
| Each `get` | A row in **Drive reads**: who, which computer, when, why, fingerprint | Your Drives board |
| The files themselves | Stay on the drive | Never uploaded |

Sensitive files are found by **name and type**, not by reading them. A scanned medical form named
`scan001.pdf` is not flagged. Encrypting the drive is the safeguard that does not depend on names.

## Windows drive letters

- Type the letter with its backslash and no quotes: `iris drives scan E:\`. In Command Prompt,
  `"E:\"` in quotes can arrive as `E:"` and fail with `Cannot see … is the drive plugged in?`.
- On Windows a drive is remembered by **this PC plus its letter**. If Windows gives the drive a
  different letter next time (it often does when another drive is plugged in first), `path` and
  `get` say it is not connected (exit 2). Give it back its old letter (Disk Management → right-click
  the drive → Change Drive Letter and Paths), or scan it again under the new letter.
- `path` and `get` for a Windows drive work on the PC that scanned it. `find`, `list` and `copies`
  work from any computer.
- IRIS cannot yet tell that a Windows drive is BitLocker-encrypted, so a BitLocker drive is listed as
  **NOT encrypted**. Check it in File Explorer (a padlock on the drive icon) or with
  `manage-bde -status E:`.

## Common problems

**`No drives cataloged yet — run: iris drives scan <drive or folder>`** Nothing has been scanned on
this account yet. Scan a drive first (Step 2).

**`Cannot see /Volumes/Footage — is the drive plugged in?`** The path is wrong or the drive is not
mounted. On a Mac, `ls /Volumes` lists the names to use (a name with spaces needs quotes:
`"/Volumes/Studio Footage"`). On Windows, see [Windows drive letters](#windows-drive-letters).

**`Not a valid path right now: <drive> is not connected to this computer`** (`path` or `get`, exit 2)
The drive is in a drawer or plugged into another computer. Plug it in here, or run the command on
the computer it is plugged into. `find` still works without it.

**`… is connected at …, but … is not there (moved or deleted since the last scan)`** (exit 3) Rescan
the drive, then `find` the file again.

**`⚠ INCOMPLETE: N folder(s) could not be read`** On a Mac your terminal app (Terminal, iTerm,
VS Code or IRIS) needs Full Disk Access: System Settings → Privacy & Security → Full Disk Access,
switch it on for that app, quit and reopen the app, then scan again. On Linux, a drive formatted on a
Mac may need `sudo`.

**`… sensitive files (drive NOT encrypted — run: iris drives list to review)`** Not an error: the scan
worked and found database dumps or password/key files on a drive anyone could read. Encrypt the
drive or move those files (Step 6), then rescan.

**`Could not read this drive's private-folder list from your account … Not scanning`** You are
offline or signed out. Reconnect and scan again. It refuses rather than risk opening a private folder.

**`Could not save the encrypted file list — this drive keeps its previous one`** The upload did not
check out. Scan again; your previous catalog of the drive is untouched.

**`<drive>: not searchable yet — scan it again`** (in `find`) The drive's file list is missing or
from an old version. Plug it in and scan it again.

**`path` says the drive is not connected, but it is plugged in.** A drive that was reformatted is a
new drive to IRIS, and on Windows the letter may have changed. Scan it again.

**`--why is required`** `get` keeps a record of every read. Say why in a few words:
`--why "send to client"`.

**`… is inside a private folder … cannot be read`** You marked that folder private when you
scanned the drive. That is working as intended: `get` never opens it.

**`… is a sensitive file (credential) …`** Add `--confirm` if you really mean to put a second copy of
it on this computer.

**`… already exists — not overwritten`** (`get`) A file with that name is already in `--to`. Pick
another folder.

**`copies` says "not checksummed yet"** The drive was scanned before fingerprints existed, or the
file is a video or larger than 64 MB. Scan the drive again (`--checksums all` to include videos).

**A finding looks wrong.** Files are judged by name, not contents. Apps (`.app`), frameworks and
plug-ins are listed as one item and never opened, so the certificates inside them are not counted.

## Coming next

A `iris drives usage` command, showing how the catalog is being used, is being built. It is not in a
released version yet; `iris drives --help` will list it when it is.

## Related

- [heyiris.io/p/drives](https://heyiris.io/p/drives): what IRIS Drives is, in one page
- `iris playbook install iris-drives`: the same steps as a guided playbook, with a check at the end
  that the catalog works from Atlas alone
- `atlas-datasets.md`: the datasets your drives catalog is stored in
- `bloq-access-control.md`: who can see your Drives board
