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

## Retention

Patient-data working copies are destroyed after **30 days** (`HIVE_PHI_RETENTION_DAYS`) by
deleting their keys. Each sweep is recorded in the audit log, with counts only.

## Requirements

Encrypted vaults need an up-to-date daemon (`iris update`, then `iris bridge restart`). Patient
data tasks can be set to require full-disk encryption (FileVault, BitLocker or LUKS) on the node.
