---
category: Data & Atlas
level: beginner
tags: [drives, backup, hard drive, flash drive, ssd, footage, find a file, encryption, bitlocker, veracrypt, sd card, duplicates, copies, checksum, audit]
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
```

`iris drives` needs version 1.5.43 or newer. Check with `iris drives --help`: it should list
`scan`, `find`, `path` and `list`. Counting copies (`copies`) and reading a file on the record
(`get`) need a newer version; if `iris drives --help` does not list them, run `iris update` again.

## Step 2: Catalog the drive

Name the private folders with `--exclude`, one per folder, relative to the drive. They are skipped
before they are opened: not listed, not counted, not named in the catalog. The list is remembered,
so every later scan of this drive, from any computer, skips them too.

To see what a scan finds before anything is saved, add `--dry-run`:

```bash
iris drives scan /Volumes/Footage --exclude Personal --dry-run
```

```
Scanning Footage (/Volumes/Footage)
  Private folders skipped, never opened: 1
  Mostly: video 3 · db-dump 1 · credential 1
Dry run — nothing was sent to your account. Would catalog 'Footage': 5 files · 6 MB · 3 project folders · 2 sensitive files (drive NOT encrypted)
```

Then catalog it for real:

```bash
iris drives scan /Volumes/Footage --exclude Personal
```

The first scan sets up a **Drives** board in your Atlas. The scan ends with one line in the same
shape as the dry run, starting `Cataloged 'Footage': …`. If the drive is not encrypted and has
sensitive files, that line says so and points you to `iris drives list`.

Other drives:

- Windows: `iris drives scan "E:\"`
- A folder on your computer: `iris drives scan ~/Projects --label "Client projects" --kind archive-folder`
- Give a drive a name you would say out loud: `--label "Studio footage 2025"`

While it scans, IRIS also takes a fingerprint (a SHA-256 checksum) of the small files that matter
most: every sensitive file, and project, document and audio files up to 64 MB. That is what lets
`copies` (Step 5b) tell two identical files from two different files with the same name. Video and
large files are skipped by default because fingerprinting reads every byte, which takes hours on a
big drive over USB. To fingerprint everything, add `--checksums all`; to skip it, `--checksums none`.
Files inside a private folder are never fingerprinted, because they are never opened.

## Step 3: See all your drives

```bash
iris drives list
```

```
Backup stick                   429 files      13.4 GB  encrypted       12 sensitive    49.1 GB free  offline  scanned 2026-11-09 · last seen on studio-mac
Footage                     40,210 files    1820.5 GB  NOT encrypted   31 sensitive   179.0 GB free  online  scanned 2026-11-09 · last seen on studio-mac
Client projects             21,025 files      13.4 GB  NOT encrypted    0 sensitive   402.7 GB free  online  scanned 2026-11-09 · last seen on laptop
```

`online` means the drive is plugged into this computer right now. Free space and "last seen on"
are as of the drive's last scan. A drive marked **NOT encrypted**
with sensitive files is the one to fix first (Step 6).

## Step 4: Find a file on any drive

```bash
iris drives find proxy mov --limit 1
```

```
Footage · not connected here — found from its catalog
  Shoots/2025-01-17/Proxies/A001_0145_Proxy.mov  · 0.03 GB · video · 2025-01-21
  … and 1196 more on Footage
```

Every word has to appear somewhere in the file's path. The search works with the drive unplugged.

## Step 5: Get the real path, if the drive is plugged in here

Use the drive's name from `iris drives list`, a colon, and the path `find` showed:

```bash
iris drives path "Client projects:Acme/brief.pdf"
```

```
/Users/you/Projects/Acme/brief.pdf
```

If the drive is not plugged into this computer it says so and exits with code 2; if the file has
moved or been deleted since the last scan, exit code 3. It never guesses.

## Step 5b: Count the copies of a file

Before you delete anything, or to check a backup really happened, ask how many copies exist:

```bash
iris drives copies final mix
```

```
final mix.wav — 3 identical copies on: Backup stick, Footage
  Backup stick: Archive/final mix.wav
  Footage: Mixes/final mix.wav
  Footage: Old/final mix (2).wav
brief.pdf — same name, different content: 2 versions
  version 1 (sha256 3fa1c09b2e44…): 1 copy
    Client projects: Acme/brief.pdf
  version 2 (sha256 9d0e27aa61c3…): 1 copy
    Footage: Acme/brief.pdf
Not checksummed yet: 1 file — scan the drive with --checksums all to compare them
  Footage: Shoots/final mix proxy.mov
```

Copies are matched by their fingerprint, not their name, so a renamed copy still counts and two
files that only share a name are shown as different versions. A file with no fingerprint yet (a
video, or a drive scanned before fingerprints existed) is listed as *not checksummed yet*: scan
that drive again, with `--checksums all` for videos. `iris drives find` also adds
`· 2 identical copies` to a file it knows has copies.

## Step 5c: Copy one file off a drive, on the record

```bash
iris drives get "Client projects:Acme/brief.pdf" --to ~/Desktop --why "send the brief to the client"
```

```
Copied Acme/brief.pdf from Client projects → /Users/you/Desktop/brief.pdf
  under 1 MB · sha256 3fa1c09b2e44d0a7… verified · recorded in your Drives board (Drive reads)
```

- The drive has to be plugged into this computer; if it is not, `get` says so and exits with code 2,
  like `path`.
- `--why` is required. It is saved, with who read the file, from which computer, when, and the
  file's fingerprint, as one row in the **Drive reads** list on your Drives board.
- The copy is checked against the original. If they do not match, the copy is deleted and nothing
  is recorded. If the record cannot be saved, the copy is deleted too.
- A file inside a private folder is refused; private folders are never opened.
- A sensitive file (passwords, keys, database dumps) needs `--confirm`, and `get` says why.
- One file at a time. A project bundle such as a `.logicx` arrives as one `.zip`.
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

For a few old files on a big drive, moving just those is quicker: copy them to an encrypted drive,
compare checksums (`shasum -a 256` on a Mac), and only then delete the originals. Never delete first.
A rescan marks the files that are gone as *moved*.

## Camera and SD cards: two copies before formatting

Cameras cannot record to an encrypted card, so keep a card's life short:

1. Copy the card to a drive and check every file.
2. Make a second copy on an **encrypted** drive and check it.
3. Scan that drive, then `iris drives find <a clip name>` should show the clip in two places.
4. Only then format the card, in the camera.

If the search does not show the footage in two places, the card is not ready to format.

## Common problems

**`No drives cataloged yet — run: iris drives scan <drive or folder>`** Nothing has been scanned on
this account yet. Scan a drive first (Step 2).

**`Cannot see /Volumes/Footage — is the drive plugged in?`** The path is wrong or the drive is not
mounted. On a Mac, `ls /Volumes` lists the names to use.

**`⚠ INCOMPLETE: N folder(s) could not be read`** On a Mac your terminal app needs Full Disk Access
(System Settings → Privacy & Security → Full Disk Access), then quit and reopen it and scan again.

**`Could not read this drive's private-folder list from your account … Not scanning`** You are
offline or signed out. Reconnect and scan again. It refuses rather than risk opening a private folder.

**`Could not save the encrypted file list — this drive keeps its previous one`** The upload did not
check out. Scan again; your previous catalog of the drive is untouched.

**`path` says the drive is not connected, but it is plugged in.** A drive that was reformatted is a
new drive to IRIS. Scan it again.

**`--why is required`** `get` keeps a record of every read. Say why in a few words:
`--why "send to client"`.

**`… is inside a private folder … cannot be read`** You marked that folder private when you
scanned the drive. That is working as intended: `get` never opens it.

**`… is a sensitive file (credential) …`** Add `--confirm` if you really mean to put a second copy of
it on this computer.

**`copies` says "not checksummed yet"** The drive was scanned before fingerprints existed, or the
file is a video or larger than 64 MB. Scan the drive again (`--checksums all` to include videos).

**A finding looks wrong.** Files are judged by name, not contents. Apps (`.app`), frameworks and
plug-ins are listed as one item and never opened, so the certificates inside them are not counted.

## Related

- `atlas-datasets.md`: the datasets your drives catalog is stored in
- `bloq-access-control.md`: who can see your Drives board
