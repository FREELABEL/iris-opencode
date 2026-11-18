---
category: Infrastructure
level: intermediate
tags: [vault, vaults, encryption, phi, hive, node, keychain, passphrase, retention, crypto-shred, storage, external drive, backup drive, replicas, sync, auto sync, heal, spare, lost copy, self-healing]
duration_min: 8
---
# How to: Use vaults

## What this does

`iris vault` holds two kinds of vault:

- **Replicated vaults** — your files, encrypted on your machine and copied to your other
  machines. No third party in the path.
- **Encrypted PHI vaults** (`--encrypted`) — where a robot task's patient-data output lands on a
  node: results, screenshots, run progress. Each has its own key and can be bound to one
  workspace, so a task for one client can never open another client's vault.

A patient-data task gets its vault automatically. Use these commands to pre-create one, fill it
with files you already have, lock it, or destroy it.

## Steps

```bash
iris vault                                   # or: iris vaults — lists everything
iris vault create backups                    # replicated vault
iris vault create intake --encrypted --bloq 174               # PHI vault for one workspace
iris vault create intake --encrypted --bloq 174 --passphrase  # stays locked after restarts
iris vault list --all                        # encrypted vaults on every node you own
iris vault lock intake
iris vault unlock intake
iris vault destroy intake                    # deletes the key: contents unrecoverable
```

## Put files in, get them back

`put / get / ls / status` work on both kinds:

```bash
iris vault put intake scan.pdf --as 2026/scan.pdf   # encrypted on this machine, read back, checked
iris vault ls intake
iris vault get intake 2026/scan.pdf --out ./restored
iris vault status intake
```

- An encrypted vault is filled on the machine that holds it, with its own key. Its files never
  leave that machine and are never copied to your other machines.
- A locked vault refuses: `unlock it first: iris vault unlock intake`.
- A passphrase vault asks for its passphrase. In a script, pass `--passphrase-stdin`.
- If a replicated vault and an encrypted vault share a name, add `--encrypted` or `--replicated`.
- `get` writes the file out unencrypted. Delete it when you are done.
- Errors go to stderr with a non-zero exit. With `--json`, stdout holds only JSON.

## Copies on your own drives (`--on`)

A replicated vault can keep its copies on external drives as well as on your machines. Name the
places with `--on`: drives by their name in `iris drives list` (catalog a drive first with
`iris drives scan`), machines by their name in `iris hive nodes list`, and `this-machine` for the
one you are on.

```bash
iris vault create studio --on "Backup A,Backup B,this-machine"        # three copies
iris vault create studio --on "Backup A,studio-mac" --replicas 2     # flagged when fewer than 2
iris vault put studio mix.wav
iris vault status studio            # each copy checked now; --deep re-hashes every chunk on a drive
iris vault sync                     # a drive just plugged in here catches up (the daemon also does it on its own)
```

- **Where it goes.** On a drive: `<drive>/_IRIS_VAULT/<vault>/`, holding encrypted chunks named
  by their own sha256, an index of those chunks, and the file list sealed with the vault key. On a
  machine: its own vault folder. The machine you create the vault on always keeps a copy too.
- **Free space first.** Before anything is written, each place is checked for room: a machine
  keeps 1 GiB free; a drive keeps 2% of its size (at least 16 MiB, at most 1 GiB). A place
  without room is skipped and named.
- **A drive that is not plugged in is pending, not failed.** Plug it into any of your machines:
  the IRIS daemon there catches it up (see below), or run `iris vault sync` there yourself. It copies the missing chunks from that machine, from another copy
  plugged in next to it, or from the machine the vault was created on (`--from <machine>` to pick
  one) over your Hive (ssh on Tailscale). The machine doing the sync needs no key: it moves
  encrypted chunks and checks each one's sha256 before storing it.
- **Only the places you named are contacted.** A vault made with `--on` never asks your other
  machines.
- **Copies are counted, not assumed.** `status` asks each machine and reads each drive plugged in
  here. A drive that is not plugged in counts only if your Drives catalog says it held everything
  at the current version when last checked, and that check is less than 14 days old
  (`IRIS_VAULT_MISSING_DAYS`). After that it is reported missing and stops counting.
- **Bytes never pass through IRIS servers.** Your Drives board records where each copy is and when
  it was last verified; the chunks move only between your own drives and machines.

### Catching up on its own when a drive is plugged in

You do not have to run `iris vault sync` yourself. The IRIS daemon on each of your machines
notices when a drive is connected. If the drive holds a copy that is pending or behind, the daemon
brings it up to date about 20 seconds later. It does the same work as `iris vault sync`: only
encrypted chunks move, and each one's sha256 is checked.

- **One at a time.** Each vault has a lock, so two catch-ups of the same vault never run together.
  A second drive plugged in during a catch-up gets its own run afterwards.
- **It never asks.** If a step needs the vault key and the key is behind a passphrase, that vault
  is skipped and the daemon log says why. Run `iris vault sync` in a terminal to finish it.
- **Battery.** On a Mac in Low Power Mode, or on a laptop running on battery below 30%, the
  catch-up waits and tries again 10 minutes later.
- **What it records.** Each catch-up adds a line to the daemon log, sets the copy's "Last
  catch-up" in your Drives catalog, and updates the drive's card ("caught up 3 files"). `iris vault
  status <vault>` shows it as `Backup B: caught up 3 files, 2 min ago`.

```bash
iris vault auto status            # on or off on this machine, and each vault's last catch-up
iris vault auto off               # this machine stops catching up and healing on its own
iris vault auto on
iris vault auto off studio        # this vault is never caught up or healed on its own, on any machine
```

How the daemon notices a drive: on a Mac it watches `/Volumes`. On Linux it checks the mount
table every 5 seconds. On Windows it checks the drive letters every 15 seconds; this is best
effort. Whatever the system, `iris vault sync` still works by hand.

### When a copy is lost: spares

A copy nobody has verified for **14 days** counts as **lost**. IRIS then rebuilds it on a
**spare**: a drive or machine you named for that vault. It never uses any other drive or machine.
The rebuild copies encrypted chunks from the copies that are still there, checks each one, and
needs no key.

```bash
iris vault create studio --on "Backup A,Backup B,this-machine" --spare "Spare A,studio-mac"
iris vault spare add studio "Spare B"        # or add spares later
iris vault spare list studio                 # tried in this order
iris vault heal --dry-run                    # what is lost, and which spare would take it
iris vault heal studio                       # rebuild now (the daemon also runs this once a day)
iris vault policy studio                     # show the settings below
```

| Setting | Default | Change it |
|---|---|---|
| A copy counts as lost after | 14 days unseen | `iris vault policy studio --lost-after 7d` (`m`, `h`, `d`, `w`) |
| Where a lost copy is rebuilt | only the vault's spares, in the order you listed them | `iris vault spare add` / `remove` |
| No spare can take it | an alert only: in `iris vault status`, `iris drives list` and the drive's card in Atlas | add a spare, or plug the drive back in |
| The lost copy comes back | both copies are kept, and both count | `--on-return retire` deletes the spare's copy |
| Automatic catch-up and heal | on | `iris vault auto off [<vault>]` |

- **A spare must be reachable and have room.** A spare drive must be plugged into the machine
  running the heal. A spare machine must answer over your Hive. Free space is checked first, as
  above. If no spare can take the copy, nothing is written. The alert names each spare and the
  reason it was passed over.
- **Why both copies are kept by default.** When a lost copy comes back, removing the spare's copy
  would delete a verified copy. It would also leave you relying on a drive that just went missing
  for two weeks. Keeping both costs only space you already set aside for the vault. With
  `--on-return retire`, the spare's copy is deleted only after the returned copy is verified
  complete and up to date, and only where IRIS can reach the spare.
- **Settings travel with the copies.** Each copy's `vault.json` holds the vault's places, spares
  and lost-after, and so does its row in your Drives catalog. A machine with only the drive plugged
  in can still catch it up and heal it, without the vault or its key. Change a vault's settings on
  the machine it was made on, or on one that imported its key.
- **Missing and lost.** A copy that has not been checked for 14 days (`IRIS_VAULT_MISSING_DAYS`)
  stops counting toward the minimum. It is lost when it passes the vault's lost-after. With both at
  the default of 14 days, the two happen together.

### Reading a drive's copy on another of your machines

The key never travels with the drive. To open the copy on another machine, move the key there
sealed with a passphrase, once:

```bash
# on the machine that has the vault
iris vault key export studio --out studio.ivk
# copy studio.ivk to the other machine (it is sealed), then there:
iris vault key import studio.ivk
iris vault get studio mix.wav --out ~/Desktop     # read straight off the drive plugged in there
```

`get` reads chunks from that machine, then from a copy on a drive plugged in there, then from your
other machines. If the drive's copy holds files put after the export, `get` picks up the newer file
list from the drive (it opens only with the key). The imported key is wrapped again by that
machine's own key-wrapping key: Keychain, Secret Service, node key or passphrase, as below.

## Where replicated-vault keys live

Each replicated vault has its own key. On disk, every key is sealed (AES-256-GCM) in
`~/.iris/vault-keys.wrapped.json`. That file is useless without a second key, which lives in one
place per machine, chosen the first time and then kept:

| Machine | Where the second key lives |
|---|---|
| Mac | macOS Keychain (`iris-replicated-vault`) |
| Linux desktop | Secret Service (GNOME Keyring / KWallet) |
| Headless Linux node | `/etc/iris/vault-kek/<uid>.key`: outside your home folder, in a folder only root can change |
| Anywhere else | a passphrase you type (scrypt N=2^17, r=8, p=1). Scripts pass `--passphrase-stdin` |

A backup, a synced folder or a copy of `~/.iris` on an external drive holds no usable key. On a
headless node, a program running as you can still read the node key: if that matters, use a
passphrase (`iris vault key setup --backend passphrase`).

```bash
iris vault key status                        # where this machine keeps them (never prints a key)
iris vault key setup --node-key              # headless Linux, once: asks for sudo
iris vault key export backups --out backups.ivk   # sealed with a passphrase you choose
iris vault key import backups.ivk            # on your other machine; then `vault get` works there
```

- An older CLI kept keys in plain text in `~/.iris/vault-keys.json`. The first vault command
  wraps them, checks every one, then overwrites and deletes that file. If it is interrupted, the
  next command finishes the job and no key is lost.
- If a key file can be read by other users, the command stops and tells you to `chmod 600` it.
  Treat those keys as exposed.
- Keys never sync. To use a vault on another machine, export and import it. Copying
  `vault-keys.wrapped.json` alone does not work.

## Retention

Patient-data working copies are destroyed after **30 days** (`HIVE_PHI_RETENTION_DAYS`) by
deleting their keys. Each sweep is recorded in the audit log, with counts only.

## Requirements

Encrypted vaults need an up-to-date daemon (`iris update`, then `iris bridge restart`). Patient
data tasks can be set to require full-disk encryption (FileVault, BitLocker or LUKS) on the node.
