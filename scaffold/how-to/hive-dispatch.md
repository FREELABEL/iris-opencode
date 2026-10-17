---
category: Infrastructure
level: beginner
tags: [hive, old-laptop, remote, run, machines]
duration_min: 10
---
# How to: Connect a machine to the Hive and run a job on it

## What this does

Turns a machine you already own, like the old laptop in a drawer or an office PC nobody uses, into
part of your **Hive**: a private network of your own machines. Once it's connected, you can run a
command on it from any other machine you're signed in on and read the output where you are.

Proven on `iris-hive-001`, a Dell OptiPlex from 2016 running Ubuntu: it joined the Hive minutes after
IRIS was installed, and it has run jobs for the rest of the network since.

![The old PC connects outward to the IRIS Hive with no open ports. Your laptop sends a job with iris hive run. The Hive hands the job to the old PC, which runs it, and the output comes back to your laptop.](https://cdn.heyiris.io/cloud-files/1792224644_hive-dispatch-flow.png)

## Before you start

- The old machine boots, is on the internet, and runs macOS, Linux or Windows.
- You have an IRIS account. Sign in with the same account on both machines.

## Step 1: Install IRIS on the old machine

macOS or Linux:

```bash
curl -fsSL https://heyiris.io/install-code | bash
```

On Windows, download IRIS from [heyiris.io/downloads](https://heyiris.io/downloads).

Then sign in:

```bash
iris auth login
```

## Step 2: Bring it online

On the old machine:

```bash
iris hive connect
```

```
Connecting this machine…
Online
```

It connects outward, so you don't need SSH, a VPN or any open ports. Run `iris hive connect` again
any time to check. It's safe to repeat.

## Step 3: See it from your main machine

On the machine you normally work on:

```bash
iris hive nodes list
```

```
  Name             Status     Active  Last heartbeat
  iris-hive-001    ● online   0/3     11s ago
    uptime: up 1d 0h
```

**Active** is how many jobs it is running right now, out of how many it will take at once.

## Step 4: Run a job on it

```bash
iris hive run iris-hive-001 "uname -sr && nproc && uptime -p"
```

```
→ status=completed  progress=100%

─── output ───
Linux 6.8.0-147-generic
4
up 1 day, 5 hours, 6 minutes

  ✓ completed  exit=0
```

Use the machine's name from `iris hive nodes list`. The command runs on that machine, and the output
comes back to you. It stops at the first failing step; add `--no-fail-fast` to run everything anyway.

Good first jobs for an old machine: a build, an export, a batch of transcription, a nightly backup
script. That's work you'd rather not have slowing down the machine you're using.

## Common problems

**The machine shows `offline`.** On that machine, run `iris hive connect --force` to restart its
connection. If it's still offline, run `iris hive doctor` there. It checks the connection and says
what's wrong.

**It went offline after a restart.** On Windows, `iris hive connect` registers it to start
again on its own. On macOS and Linux, run `iris hive connect` on it after a restart.

**`iris hive run` says the machine isn't found.** Use the name exactly as `iris hive nodes list`
prints it. Both machines must be signed in to the same account.

**You want proof that a job really ran there.** Run `iris hive selftest <name>`. It sends a test job
and checks that the output and exit code came back.

**You're asking an AI assistant to run it through the IRIS connector in Claude on the web, desktop
or mobile.** It will refuse `iris hive run`. That's deliberate. An assistant there also reads mail
and web pages, and text hidden in those mustn't be able to run commands on your machines. Run it from
a terminal. Read-only commands like `iris hive nodes list` still work there.

## Related

- `hive-tailscale.md`: reach a machine that isn't on your network
- `hive-rent-compute.md`: rent a machine when you don't have a spare one
- `shared-folder-across-machines.md`: one folder on every machine in your Hive
- `run-code-in-a-sandbox.md`: run something in a throwaway sandbox instead
