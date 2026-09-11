---
category: Infrastructure
level: beginner
tags: [hive, inbox, messaging, handoff, agents, peer]
duration_min: 10
---
# How to: Send work to another person's agent (Hive inbox)

## The one-paragraph version

Every connected machine has an **inbox** its agent reads. You can drop a message or a **work
item** into someone else's inbox — including someone on a different account — and their agent
picks it up. Nothing is opened to the internet: machines dial *out*, and nobody can reach you
until you accept their invite. This replaces the copy-paste loop where two people move work
between agents by hand.

## The two halves people mix up

Reaching someone is **two separate things**, and missing either one produces a confusing
silence rather than an error:

|  | Command | What it gives you |
|---|---|---|
| **Grant** | `iris hive accept <code>` | the trust relationship between two accounts |
| **Reachability** | `iris hive connect` | registers *this machine* so a message has somewhere to land |

Accepting an invite does **not** make your machine reachable. Connecting does not let anyone
message you. You need both, and the order does not matter.

## Step 1: Connect this machine

```bash
$ iris hive connect
```

Registers the computer you are sitting at and starts the background helper that watches your
inbox. Outbound only — no SSH, no VPN, no port forwarding. Name it if you like:
`iris hive connect --name kristen-laptop`.

```bash
$ iris hive doctor
```

Confirms the daemon is alive. If a message never arrives, this is the first thing to check.

## Step 2: Link up with the other person

Being connected doesn't let anyone reach you. One side invites, the other accepts.

```bash
# You (the inviter)
$ iris hive invite
#   → Invite code: EXO212OWHUAU   perms: files,chat   expires in 7 days

# Them
$ iris hive accept EXO212OWHUAU
```

Then confirm on both sides:

```bash
$ iris hive connections          # the peer should read ● active
$ iris hive peers <connection-id>   # their machines that are online right now
```

**The code is a 12-character single-use bearer credential.** Once accepted it cannot be used
again. Because it is short and not a link, the most secure delivery is to **read it aloud over a
phone call** — nothing written down, nothing to forward, no inbox to compromise. Default
permissions are `files,chat` — deliberately *not* `terminal` or `tasks`.

> `expires` is only enforced when someone ACCEPTS. An already-active connection keeps working
> past that date, so treat every `● active` row as live and remove peers you no longer want.

## Step 3: Read your inbox

```bash
$ iris hive inbox
```

```
  #   Status  Name                              From         Age        Size
  1   NEW     MSG Can you look at the Q3 nu…    MacBookPro   just now   67 B
  2   NEW     HANDOFF bloq:item:9001 [pending]  MacBookPro   2m ago     32 B
```

- `iris hive inbox read 2` — print an item to the terminal
- `iris hive inbox open 2` — open a file or link
- `iris hive inbox --unread` — only what you haven't seen
- `iris hive inbox count` — a one-line count, for a status bar

## Step 4: Send to someone's agent

```bash
$ iris hive inbox send --target <machine> "Can you look at the Q3 numbers before Friday?"
```

`<machine>` is the machine name — one of yours, **or a peer's** you are connected to. Own
machines go direct; a peer's goes over the relay, and the output says so:
`Sent to MacBookAir (Emily Glynn, via relay)`.

Files and links use the richer path:

```bash
$ iris hive send ./report.pdf --to <machine> -m "the draft we discussed"
$ iris hive send https://example.com/spec --to <machine>
```

## Step 5: Hand over a work item

This is the part that replaces pasting an item id into a chat window.

```bash
$ iris hive handoff item:1234 --target <machine> --note "Draft the reply, I'll review"
$ iris hive handoff --atlas=item:12345 --target <machine>
```

It lands in their inbox as a **handoff** — a *request*. They decide when to run it. Sending a
handoff never executes anything on someone else's computer.

To run one on **your own** machine and get the result back in your inbox:

```bash
$ iris hive handoff item:1234 --target <your-machine> --run
```

When it finishes, `iris hive inbox` shows a `JOB` row with the outcome.

## Who can reach a machine

For a personal machine, only its owner. For a machine owned by an organization, membership alone
is not enough — someone must be attached to that specific machine:

```bash
$ iris hive access list <machine>                 # who is attached
$ iris hive access grant <machine> <user-id>      # let them reach it
$ iris hive access revoke <machine> <user-id>     # take it back
$ iris hive access org <machine> <org-id>         # put the machine in an org
```

Least privilege is the default: an org member reaches nothing until an admin grants them a
specific machine.

## When something doesn't arrive

| Symptom | Cause | Fix |
|---|---|---|
| `No node(s) online` for a peer | they accepted the invite but never ran `iris hive connect` | ask them to run it, then `iris hive doctor` |
| Nothing in the inbox after a send | their daemon is down; items wait for it | `iris hive doctor` on *their* machine |
| `No node matching "<name>"` | the name isn't yours and isn't an online peer node | `iris hive nodes list` · `iris hive connections` |
| 403 sending to a peer | no active connection, or `chat` not permitted | check `iris hive connections` on both sides |
| Item never arrives, long delay | messages expire after 7 days, files after 24 hours | re-send |

A recipient's inbox lives on *their* machine — you cannot see it from your side. If you need
confirmation that something landed, ask them to run `iris hive inbox`.
