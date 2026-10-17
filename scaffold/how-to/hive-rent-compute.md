---
category: Infrastructure
level: beginner
tags: [hive, compute, hosting, rent, railway]
duration_min: 10
---
# How to: Rent a machine and run your code on it

## What this does

Rents a **long-lived machine**: a server you keep, not a job that finishes. IRIS starts it,
puts the IRIS agent on it so it joins your Hive, and you run work on it like any other machine you
own. You release it when you're done, and that stops the bill.

![iris hive rent starts a machine, which shows as starting up until it checks in. Once it checks in it shows as in your hive, and iris hive run sends it work. It is billed the whole time it is up, from rent until iris hive release, which is the only thing that stops the bill.](https://cdn.heyiris.io/cloud-files/1792224198_hive-rent-compute-lifecycle.png)

**Just need to run one command somewhere safe?** That's a sandbox, not a rental: it costs nothing
when idle and is gone afterwards. See `run-code-in-a-sandbox.md`.

## Before you start

- You're signed in: `iris auth login`
- **Renting is switched on per account.** Check before anything else:

```bash
iris hive providers
```

```
  railway        not configured — needs an API token (default)
  cloudflare     ready
```

That's a real account where **renting isn't on yet**: `railway` is the provider rentals use, and it
reads *not configured*. `cloudflare` is sandboxes, which work. If yours looks like this, email
team@heyiris.io to have renting switched on. The token is set on our side, so there's nothing to
install. Until then, a sandbox runs one-off commands.

When `railway` reads `ready`, carry on.

## Step 1: Rent a machine

```bash
iris hive rent my-box
```

It joins your Hive automatically, so everything you already do with Hive works on it.

## Step 2: Wait for it to check in

```bash
iris hive rentals
```

The last column is **what the machine has confirmed, not what you asked for**:

| Status | Means |
|---|---|
| `in your hive` | it checked in within the last five minutes. This is the only state that means it works |
| `starting up` | rented, never checked in yet. Still booting, or the agent didn't install |
| `not reporting` | it was checking in and stopped |
| `no node linked` | it rented but never registered, so nothing can reach it |
| `plain box` | you rented it with `--no-hive`: on purpose, no agent |

With nothing rented, it says so:

```
  No machines rented.  Rent one:  iris hive rent my-box
```

## Step 3: Run your code on it

```bash
iris hive run my-box "python3 -c 'print(sum(i*i for i in range(1000)))'"
```

Python, PHP, Node, shell: the machine is the runtime. There's nothing to deploy.

## Step 4: Release it when you're done

```bash
iris hive release <id>
```

Use the id from `iris hive rentals`. **This is the only thing that stops the bill.** Until you run
it, the machine stays up. That's the point of a rental, and it's why nothing releases it for you.

## If you don't want IRIS on the machine

```bash
iris hive rent my-box --no-hive
```

You still have the machine, and it's still billed, but the IRIS agent isn't on it. So **you can't
send it work**: it won't appear in `iris hive nodes list`, and `iris hive run` won't reach it. You get
ssh and nothing else.

## Common problems

**`not configured — needs an API token`.** Renting isn't switched on for your account yet. Email
team@heyiris.io. It's a one-time switch on our side.

**`Release FAILED: … the machine may still be running and billing`.** The teardown didn't go
through, so the machine may still exist. Run `iris hive rentals` to check, then retry the release.

**It's stuck on `starting up`.** Give it a minute. If it stays there, it booted without the agent:
check you didn't pass a custom `--image` that lacks it. Leave `--image` off to get the default.

**It says `not reporting`.** It worked and then stopped checking in. Run `iris hive selftest <name>`
to see whether it still takes work.

## Related

- `run-code-in-a-sandbox.md`: run one command in a throwaway box instead
- `hive-dispatch.md`: run work on a machine you already own
- `hive-tailscale.md`: reach a machine that isn't on your network
