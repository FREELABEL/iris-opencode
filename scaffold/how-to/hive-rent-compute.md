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

There is a page that explains the product, and a wizard if you would rather click than type:

- **https://freelabel.net/p/hive-marketplace** — what you are renting and how you know it worked
- **https://elon.freelabel.net/dashboard/hive** — the Rent tab: provider, name, enrolment, done

The rest of this covers the terminal.

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
     7  my-box                 railway       active     in your hive
     8  render-box             railway       active     starting up
     9  old-box                railway       active     not reporting
```

**The last column is what the machine confirmed, not what you asked for.** Renting a machine and
having a machine are different events, and the column distinguishes them:

| | |
|---|---|
| `in your hive` | it checked in within the last five minutes — the only state that means it works |
| `starting up` | rented, never checked in. Still booting, or the install did not take |
| `not reporting` | it was checking in and stopped. Different from never having started |
| `no node linked` | something was lost between renting and registering; nothing can reach it |
| `plain box` | you rented with `--no-hive`. An absence with a reason |

It used to print `hive node` for anything rented with enrolment requested, which meant a machine
that never booted looked exactly like one taking work.

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
`iris hive rentals` says which of the four reasons it is. `starting up` means give it a minute;
if it stays there, the machine booted without the agent — check you did not pass a custom
`--image` that lacks it. `plain box` means you asked for that with `--no-hive`. `not reporting`
means it worked and stopped, which is the one worth looking at.

**I passed my own `--image` and the machine never appeared**
An explicit image is always honoured, and we cannot tell from outside whether yours contains the
IRIS agent. If it does not, the machine boots, bills, and never joins. Leave `--image` off to get
the default agent image, or make sure your own is built from it.

## Related

- `iris hive run` — run a command on any machine in your Hive
- `iris hive selftest <node>` — prove a machine's transport actually works
- `iris hive nodes list` — every machine in your Hive, rented or your own
- **https://freelabel.net/p/hive-marketplace** — the page to send someone who has not used it
