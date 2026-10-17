---
category: Infrastructure
level: intermediate
tags: [hive, drive, shared-folder, juicefs, r2, files, sync]
duration_min: 15
---
# How to: Share one folder across all your machines

## What this does

One folder that lives on every machine in your Hive — your laptop, a server, an agent's sandbox.
Open a file and only the parts you read are downloaded (a 200 MB video does not fill your disk);
save a file and every other machine sees it straight away.

![Every machine in your Hive mounts the same folder at ~/IrisDrive/team. A small file index on one of your Hive machines, reached over your tailnet, keeps the list of files. Your own storage bucket, such as Cloudflare R2 or any S3, holds the contents, and a machine downloads only the parts of a file it reads.](https://cdn.heyiris.io/cloud-files/1792224654_shared-folder-across-machines-how.png)

## Before you start

- A storage bucket (Cloudflare R2 or any S3) — **use one for drives only, with a key limited to it**
- A small file index every machine can reach — e.g. Redis on one of your Hive machines, over the
  tailnet, with a password

## Step 1: Install the drive engine on each machine

On a machine that doesn't have it yet, `iris hive drive status` says so:

```bash
iris hive drive status
```

```
  juicefs   not installed — iris hive drive install
  no drives — iris hive drive create <name> --meta … --bucket …
```

Install it:

```bash
iris hive drive install
```

This installs JuiceFS 1.4.1 into `~/.iris/bin`, checksum-verified.

## Step 2: Create the drive, once, on one machine

```bash
ACCESS_KEY=… SECRET_KEY=… iris hive drive create team \
  --meta "redis://:PASSWORD@100.x.y.z:6379/1" \
  --bucket "https://ACCOUNT.r2.cloudflarestorage.com/BUCKET"
```

## Step 3: Join it from every other machine, with the same `--meta`

```bash
iris hive drive join team --meta "redis://:PASSWORD@100.x.y.z:6379/1"
```

## Step 4: Mount it

```bash
iris hive drive mount team        # → ~/IrisDrive/team
```

**A Mac without macFUSE?** Serve it instead, then open it in Finder (Go → Connect to Server, ⌘K):

```bash
iris hive drive serve team        # http://127.0.0.1:9007/
```

## Step 5: Check it

```bash
iris hive drive status
```

## Good to know

- Every machine writes as one shared identity (default `501:20`, a Mac's first user), so a folder
  made on one machine is writable from all the others. Pick a different one at create time with
  `--identity` if all your machines are Linux.
- The password in `--meta` is stored readable only by you and is never printed.

## Common problems

**"cannot reach that metadata store"** — the index is not reachable from this machine (tailnet off?)
or the password is wrong.

**"that metadata store holds no drive called …"** — check the drive name.

**Writes refused in a folder another machine created** — that machine is not using the drive's
shared identity; remount it with `iris hive drive mount`.

## Related

- `hive-dispatch.md`: connect a machine to your Hive first
- `hive-tailscale.md`: reach a machine that isn't on your network (the file list is reached over your tailnet)
- `run-code-in-a-sandbox.md`: run something in a throwaway box instead
