---
category: Infrastructure
level: intermediate
tags: [vault, vaults, encryption, phi, hive, node, keychain, passphrase, retention, crypto-shred, storage]
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
