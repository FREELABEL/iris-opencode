---
category: Infrastructure
level: intermediate
tags: [vault, vaults, encryption, phi, hive, node, keychain, passphrase, retention, crypto-shred, storage, external drive, backup drive, replicas, sync]
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
iris vault sync                     # a drive just plugged in here catches up
```

- **Where it goes.** On a drive: `<drive>/_IRIS_VAULT/<vault>/`, holding encrypted chunks named
  by their own sha256, an index of those chunks, and the file list sealed with the vault key. On a
  machine: its own vault folder. The machine you create the vault on always keeps a copy too.
- **Free space first.** Before anything is written, each place is checked for room: a machine
  keeps 1 GiB free; a drive keeps 2% of its size (at least 16 MiB, at most 1 GiB). A place
  without room is skipped and named.
- **A drive that is not plugged in is pending, not failed.** Plug it into any of your machines and
  run `iris vault sync` there. It copies the missing chunks from that machine, from another copy
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
