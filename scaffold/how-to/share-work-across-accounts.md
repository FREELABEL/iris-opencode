---
category: Data & Atlas
level: intermediate
tags: [bloqs, hive, sharing, handoff, access, peers]
duration_min: 12
---
# How to: Let someone on another account open the work you sent them

## The one-paragraph version

You hand a teammate or client a work item — over `iris hive handoff`, or just by telling them an
id — and they get **a permission error**. The reference travelled; the permission to open it did
not. This recipe covers the four ways to fix that, which one to reach for, and the one that
cannot be undone.

## The trap, stated plainly

`iris hive handoff bloq:item:184653 --target their-machine` **succeeds** and delivers a `HANDOFF`
row to their inbox. Their agent then runs `iris atlas get-item 184653` and is refused, because
the item lives on *your* board and their account was never granted anything.

Nothing warns you. The send returns `ok`, the task completes, and the failure appears only on
their side — so the sender believes it worked. Filed as #184654.

**The payload was never the problem.** If you just need them unblocked in the next minute, send
the content as a message and skip permissions entirely:

```bash
$ iris hive inbox send --target their-machine "<the actual text>"
```

That always works. Everything below is for when they need the *item* — to comment on it, run it,
or refer back to it.

## Four ways to grant access, narrowest first

| # | Command | Grants | Undo |
|---|---|---|---|
| 1 | `iris bloqs invite <bloq> --scope-item <id>` | one item, via a link | `revoke-link` |
| 2 | `iris bloqs add-member <bloq> --user-id N --permission viewer` | that whole board | `remove-member` |
| 3 | `iris bloqs make-public <item> --allowed-emails a@b.com` | one item, named people only | `make-private` |
| 4 | `iris bloqs make-public <item> --force` | **the open internet** | **none — see below** |

### 1. A scoped invite link — narrowest, and usually right

```bash
$ iris bloqs invite 625 --scope-item 184653 --email them@example.com --max-uses 1
```

One item, one redemption, addressed to a person. `--email` addresses the invite; it does **not**
send mail. Add `--expires 2026-12-31` if it should die on its own.

### 2. Board membership — when they need more than one thing

```bash
$ iris bloqs add-member 625 --user-id 5083 --permission viewer
$ iris bloqs members 625          # ALWAYS verify — the success line is not the check
```

Two things people get wrong here:

- **The default permission is `editor`, not viewer.** Pass `--permission viewer` unless you mean
  to let them change things.
- **It grants the ENTIRE board.** Before running it, read the member list and the board's
  contents. An internal board with 500+ rows is not a place to attach a client so they can read
  one runbook.

Move the item somewhere appropriate instead — the id survives:

```bash
$ iris bloqs update-item 184653 --to-bloq 625 --to-list 2154
```

Their `iris atlas get-item 184653` then works unchanged.

### 3. A gated public link — a named audience, not the world

```bash
$ iris bloqs make-public 184653 --allowed-emails emily@example.com
$ iris bloqs make-public 184653 --allowed-domains vanguardhcs.com
```

`--allowed-emails` is **required for PHI-classified items**, and it is the option people miss
because they assume "public" has only one setting. It does not.

### 4. Ungated public — the one you cannot take back

```bash
$ iris bloqs make-public 184653 --force
```

The CLI refuses this without a terminal, and the refusal is right:

> This puts the note on the open internet — anyone at all, including crawlers.
> Once fetched it can be cached, indexed and forwarded. Making it private later does not un-send it.

`make-private` closes the door; it does not recall what already left. **Do not reach for `--force`
to save someone one command.** Use 1 or 3.

## Choosing, in one line each

- They need **one item, once** → scoped invite (1).
- They need **an ongoing project** → move the item to a share board, add them as viewer (2).
- They are **outside IRIS entirely** → gated public link (3).
- You want it **indexed by search engines** → and only then, (4).

## Checking what you have already shared

```bash
$ iris bloqs members <bloq>        # accounts with access, and at what level
$ iris bloqs links <bloq>          # outstanding invite links
$ iris bloqs revoke-link <bloq> <linkId>
```

> **There is no reverse lookup yet.** You cannot ask "which boards can this person see?" or
> "what do these two people share" — membership reads one board at a time, so an access review
> means walking every board by hand. Filed as #184656.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `iris atlas get-item <id>` refused on their side | the item is on a board they are not on | grant via 1-3, or move the item to a shared board |
| Handoff delivered, item unopenable | the reference shipped without permission (#184654) | same, or re-send the content as a message |
| `Refusing to widen … without a terminal` | ungated `make-public` in a script | you almost certainly want `--allowed-emails` instead |
| They were added but still cannot edit | `--permission viewer` | re-add with `editor` if that is genuinely intended |
| You added them and nothing was emailed | nobody is notified by default | tell them out of band, or pass `--notify` |

## Related recipes

- `bloq-access-control.md` — the other half: scoped invite links on a board you own, and the two
  exposures that surprise people
- `hive-inbox.md` — sending messages and handoffs between agents in the first place
- `bloq-relations.md` — linking bloqs into a project hierarchy
