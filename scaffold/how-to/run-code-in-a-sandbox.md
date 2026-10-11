---
category: Infrastructure
level: beginner
tags: [hive, compute, sandbox, cloudflare, python, node, run-code, agents]
duration_min: 5
---
# How to: Run code in a throwaway sandbox

## What this does

Runs a command — a Python one-liner, a Node script, a `git clone` and a test run — in a fresh,
isolated Linux machine that exists only for that command. You get the output and the exit code;
then the machine is gone. Nothing runs on your computer, and nothing is left behind to pay for.

Use it when you want to run something you do not fully trust (code an AI wrote, a script from the
internet), or when you need Python or Node and do not have them where you are.

**What is in the box:** bash, Python 3 (with `pip install` working), Node with npm, git, curl, jq. **What is not:** your files, your
keys, your accounts — a sandbox sees only the command you give it. Internet access is **off**
unless you ask for it, so a command cannot send anything anywhere by accident.

## Prerequisites

- Signed in: `iris auth login`
- IRIS CLI **v1.3.335+** (`iris update`)

Check sandboxes are available for your account:

```bash
iris hive providers
```

`cloudflare   ready` means you are set.

## Steps

**1. Run a command**

```bash
iris hive sandbox "python3 -c 'print(6*7)'"
```

```
42
```

The command's output is printed as-is, and `iris` exits with the command's own exit code, so it
works inside scripts: `iris hive sandbox "pytest" && echo passed`.

**2. Let it reach the internet when it needs to**

```bash
iris hive sandbox --internet "git clone --depth 1 https://github.com/psf/requests && ls requests"
```

**3. Keep a sandbox for several commands**

By default each command gets a brand-new sandbox. To build something up over several steps — write
a file, then run it — keep one:

```bash
iris hive sandbox --keep "echo 'print(\"hello\")' > hello.py"
#   kept sandbox #57 — reuse: iris hive sandbox --id 57 "<command>"
iris hive sandbox --id 57 "python3 hello.py"
iris hive release 57            # done — stop it
```

A kept sandbox you forget about stops itself after 10 idle minutes, and costs nothing while idle.

**4. Give a long command more time**

Commands are stopped after 30 seconds unless you say otherwise (up to 120):

```bash
iris hive sandbox --timeout 120 --internet "pip install -q requests && python3 -c 'import requests; print(requests.__version__)'"
```

A command that runs past its time is stopped and its sandbox is reset — it cannot keep running in
the background.

## Your agents can do this too

An IRIS agent can run code in the same kind of sandbox instead of guessing at an answer. Ask it in
plain words — *"run this and tell me what it prints"*, *"check that this regex matches these five
lines"*, *"what is the SHA-256 of this string?"* — and it runs the code and answers from the real
output.

The same rules hold: a fresh sandbox per request, released afterwards; internet off unless the
request needs it; nothing from your account goes into the box. Agents in workspaces that hold
patient health information cannot use it.

If an agent says it has no way to run code, its tool list was set by hand and does not include
sandboxes yet — ask your IRIS contact to add it.

## Sandbox or rented machine?

| You want | Use |
|---|---|
| Run something once and see the result | **This** — `iris hive sandbox` |
| A server that stays up, a website, a GPU | `iris how-to view hive-rent-compute` — `iris hive rent` |

## Common problems

**`Cloudflare sandboxes are not switched on for this account yet`** — `iris hive providers` shows
`cloudflare` as not configured. Ask your IRIS contact; it is a one-time switch on our side.

**`Could not resolve host` / `Failed to connect`** — internet is off by default. Add `--internet`.

**`stopped after 30s`** — raise `--timeout` (max 120). For work that takes longer than two
minutes, rent a machine instead.

**`No such file` on the second command** — each command gets a new sandbox unless you use
`--keep` and then `--id`.

**`output was cut at 256 KB`** — write the result to a file in a kept sandbox and read the part you
need, e.g. `--id 57 "tail -50 results.txt"`.

## Related

- `iris how-to view hive-rent-compute` — rent a machine that stays up
- `iris hive sandbox --help` — every flag
