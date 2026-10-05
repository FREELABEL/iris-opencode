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

A patient-data task gets its vault automatically — you only need these commands to pre-create
one with a passphrase, lock it, or destroy it.

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

Replicated vaults: `iris vault put / get / ls / status`.

## Retention

Patient-data working copies are destroyed after **30 days** (`HIVE_PHI_RETENTION_DAYS`) by
deleting their keys. Each sweep is recorded in the audit log, with counts only.

## Requirements

Encrypted vaults need an up-to-date daemon (`iris update`, then `iris bridge restart`). Patient
data tasks can be set to require full-disk encryption (FileVault, BitLocker or LUKS) on the node.
