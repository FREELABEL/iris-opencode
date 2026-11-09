---
category: Data & Atlas
level: beginner
tags: [drives, backup, hard drive, flash drive, ssd, footage, find a file, encryption, bitlocker, veracrypt, sd card]
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
`scan`, `find`, `path` and `list`.

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

## Step 3: See all your drives

```bash
iris drives list
```

```
BK-03                          429 files      13.4 GB  encrypted      380 sensitive  offline  scanned 2026-11-09
Redwalrus                   60,072 files    4147.9 GB  NOT encrypted  292 sensitive  offline  scanned 2026-11-09
Hive archive                21,025 files      13.4 GB  NOT encrypted    0 sensitive  online  scanned 2026-11-09
```

`online` means the drive is plugged into this computer right now. A drive marked **NOT encrypted**
with sensitive files is the one to fix first (Step 6).

## Step 4: Find a file on any drive

```bash
iris drives find proxy mov --limit 1
```

```
Redwalrus · not connected here — found from its catalog
  SourceFootage/Proxies/20250117_fx30_0145_Proxy.mov  · 0.03 GB · video · 2025-01-21
  … and 1196 more on Redwalrus
```

Every word has to appear somewhere in the file's path. The search works with the drive unplugged.

## Step 5: Get the real path, if the drive is plugged in here

Use the drive's name from `iris drives list`, a colon, and the path `find` showed:

```bash
iris drives path "Hive archive:sandisk-ultra-logic/MOVED-TO-ENCRYPTED-BK-03.txt"
```

```
/home/siralexmayo/archive/sandisk-ultra-logic/MOVED-TO-ENCRYPTED-BK-03.txt
```

If the drive is not plugged into this computer it says so and exits with code 2; if the file has
moved or been deleted since the last scan, exit code 3. It never guesses.

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

**A finding looks wrong.** Files are judged by name, not contents. Apps (`.app`), frameworks and
plug-ins are listed as one item and never opened, so the certificates inside them are not counted.

## Related

- `atlas-datasets.md`: the datasets your drives catalog is stored in
- `bloq-access-control.md`: who can see your Drives board
