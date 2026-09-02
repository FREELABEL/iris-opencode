---
category: Infrastructure
level: beginner
tags: [hive, compute, hosting, rent, gpu, railway]
duration_min: 10
---
# How to: Rent a machine and run your code on it

## What this does

Rents a **long-lived machine** — a server you keep, not a job that finishes. IRIS provisions it,
installs the IRIS agent on it by default so it joins your Hive, and you run work on it like any
other machine you own. You release it when you are done, and it stops costing money.

This is different from a Hive task, which borrows a machine you already have for a few seconds.
A rental is yours until you release it.

## Prerequisites

- `iris auth login`
- A configured provider. Check with `iris hive providers` — anything reading
  *"not configured"* needs an API token set before you can rent from it.

## Steps

**1. See what you can rent from**

```bash
iris hive providers
```

```
  railway        ready (default)
  digitalocean   ready · GPU
```

Railway hosts apps and keeps them running. DigitalOcean gives you a raw box, and is the one
with GPUs. If a provider says *not configured*, it exists but has no API token yet.

**2. Rent a machine**

```bash
iris hive rent my-box
```

It joins your Hive automatically, so everything you already know works on it.

**3. Run your code on it**

```bash
iris hive run my-box "python3 -c 'print(sum(i*i for i in range(1000)))'"
iris hive run my-box "php -r 'echo PHP_VERSION;'"
```

Python, PHP, node, shell — the machine is the runtime. Nothing to deploy.

**4. See what you are paying for**

```bash
iris hive rentals
```

```
    id  name                   provider      status     hive
     7  my-box                 railway       active     hive node
```

**5. Release it when you are done**

```bash
iris hive release 7
```

This is the one that stops the bill. Until you run it, the machine stays up — that is the
point of a rental, and it is also why nothing releases it for you.

## If you do not want IRIS on the machine

```bash
iris hive rent my-box --no-hive
```

The machine is still yours and still billed, but IRIS is not installed on it — so **you cannot
dispatch work to it**, it will not appear in `iris hive nodes list`, and `iris hive run` will
not reach it. You get ssh and nothing else.

Worth being clear about what the default grants: installing the agent is what lets IRIS run
work on that machine. That is the real choice, not whether a CLI gets installed.

## Common problems

**`not configured — needs an API token`**
The provider exists but has no credentials. That is a setup step, not a broken command.

**`Release FAILED: … the machine may still be running and billing`**
The teardown call did not succeed, so the machine may still exist. Run `iris hive rentals` to
check, and retry. A release that fails is reported as a failure on purpose — it would be worse
to say "released" and leave you paying.

**The machine is not in `iris hive nodes list`**
Either it is still starting, or it was rented with `--no-hive`. `iris hive rentals` shows which:
a rental that declined enrolment reads *not enrolled* rather than simply being absent.

## Related

- `iris hive run` — run a command on any machine in your Hive
- `iris hive selftest <node>` — prove a machine's transport actually works
- `iris hive nodes list` — every machine in your Hive, rented or your own
