---
category: Data & Atlas
level: intermediate
tags: [bloqs, security, sharing]
duration_min: 12
---
# How to: Share a bloq without leaking the parts you didn't mean to share

## What this does

Shows you how to give someone access to **part** of a bloq board, how to check what
you've already shared, and — most importantly — the two things sharing exposes that
people consistently don't expect.

Read the **Know before you share** section even if you skip the rest. It is short and it
is the part that bites.

## Prerequisites

- `iris auth login` completed
- A bloq you own (`iris bloqs list`)

---

## Know before you share

Two facts that are not obvious from any command's help text.

### 1. The default grants the ENTIRE board

```
iris bloqs invite 583
```

That mints a link granting **viewer on every list and every item on the board**. There is
no confirmation and no summary of what's included. The scoping flags exist but are opt-in:

```
iris bloqs invite 583 --scope-list 1844      # one list and its items
iris bloqs invite 583 --scope-item 179268    # a single item
iris bloqs invite 583 --scope-own            # only rows this person authored
```

Client project boards routinely hold client-safe and internal material side by side —
that's the correct way to run a project. The command doesn't know the difference.

### 2. ⚠️ Scoping does NOT protect the CRM notes of attached leads

**This is the one that surprises everyone, so read it twice.**

If a bloq has leads attached as contacts, **anyone you invite can read the notes on those
leads** — including when you scoped the invite to a single harmless list.

Bloq membership grants lead access through a completely separate path that never consults
the scope. So:

```
iris bloqs invite 583 --scope-list 1844   # ✅ hides your other lists and items
                                          # ❌ does NOT hide notes on attached leads
```

CRM notes tend to be the most sensitive text anyone writes — deal prep, pricing latitude,
candid reads on how a negotiation is going. And the person most likely to be invited to a
client board is very often the person those notes are *about*.

**The intuition here is backwards and it's worth naming.** The bloq — the thing literally
called *shared* — is the better-protected container. The CRM — the thing everyone treats
as internal — is the leaky one. Don't reason from the names.

> **Before inviting anyone to a board with contacts attached**, check what those contacts'
> notes say:
> ```
> iris bloqs get <bloqId>              # shows attached contacts and their lead ids
> iris leads notes <leadId>            # read before you share, not after
> ```
> Then either clean the notes, detach the contact, or don't invite.

---

## Steps

**1. See what a board actually contains before sharing it**

```
$ iris bloqs get 583
```

Gives you lists (with ids), item counts, and **attached contacts with their lead ids**.
Both halves matter: the lists are what scoping controls, the contacts are what it doesn't.

**2. Share one list, not the board**

```
$ iris bloqs invite 583 --scope-list 1844 --email them@example.com
```

`--email` addresses the invite to a person; it does **not** send mail — you still deliver
the link yourself. Useful extras:

```
--permission editor      # default is viewer
--expires 2026-12-31     # link stops working after this date
--max-uses 1             # single redemption, so a forwarded link is dead
```

`--max-uses 1` is the cheapest real protection available today. Use it by default for
anything client-facing.

**3. Check what you've already shared**

```
$ iris bloqs links 583
```

Lists active links with permission, use count, and expiry.

> **Known gap:** this does **not** show each link's scope, and neither does any other
> endpoint. Once a link is minted there is currently no way to read back whether it grants
> the whole board or one list. Until that's fixed, **record the scope when you mint it** —
> or if you're unsure about an existing link, revoke and re-mint rather than guess.

**4. Revoke when it's done**

```
$ iris bloqs revoke-link 583 55
```

Revoking stops future redemptions. It does **not** un-read anything already read, and it
does not remove members who already redeemed.

---

## The pattern that works

For a client project board where some material is internal:

1. **Put internal material in its own list.** One list, obviously named. Never scatter it.
2. **Keep everything the client should see in separate lists**, so a scoped invite is
   actually possible.
3. **Check attached contacts' lead notes** before inviting anyone (see the warning above).
4. **Invite with `--scope-list` and `--max-uses 1`**, pointed at a client-safe list.
5. **Record what you scoped it to**, because you can't read it back.

Naming a list `🔒 Internal` is useful for humans. **It is not enforced by anything** — no
command reads it. It's a note to yourself, not a control.

---

## Useful variants

```
$ iris bloqs invite 583 --scope-item 179268           # exactly one item
$ iris bloqs invite 583 --scope-own                   # only what they wrote
$ iris bloqs make-public 179268 --password hunter2    # public URL, password-gated
$ iris bloqs make-public 179268 --expires 2026-09-01  # public URL that lapses
$ iris bloqs make-private 179268                      # revoke a public item
```

`make-public` puts an item on the **open web** at a URL. `--password` and `--expires` are
opt-in; without them it's simply public.

⚠️ `iris bloqs publish-pages <bloqId>` publishes **every item in the bloq** as a page by
default. Always pass `-l <listId>` to narrow it. Note also that publishing is
point-in-time: a board that was safe when you published it can accumulate internal
material afterwards, and re-running the command sweeps that in.

---

## Expected output

```
$ iris bloqs links 583
  ────────────────────────────────────────────
  ● #55  https://web.heyiris.io/invite/SEPOfGH...
      viewer  ·  0 uses
  ────────────────────────────────────────────
  Revoke: iris bloqs revoke-link 583 <link-id>
```

`● ` means active. `0 uses` means nobody has redeemed it yet — worth checking before you
decide whether a mistake actually reached anyone.

---

## Common errors

| What you see | Why | Fix |
|---|---|---|
| Invite works but they see everything | No `--scope-*` flag — the default is board-wide | Revoke, re-mint with `--scope-list` |
| They can see leads/contacts you didn't expect | Known gap — scoping never applies to attached leads | Detach the contact, or clean its notes |
| `Invalid scope` on mint | The list/item id isn't on that bloq | Get the right id from `iris bloqs get <bloqId>` |
| Link shows `0 uses` but they say they have access | They redeemed a *different* link, or were added directly | `iris bloqs links` lists all of them |
| Revoked the link, they still have access | Revoking blocks new redemptions only | Membership is separate — remove the member |

---

## Why the defaults are like this

Not carelessness — the enforcement underneath is genuinely well built. `BloqAccessScope`
is a single centralised service that every reader of lists and items goes through, added
precisely because "the smallest grantable unit was a 297-item tracker."

The gaps are narrower than they look: the **default** is wide, items carry no
**sensitivity marker** so no command can decline, a minted link's **scope is unreadable**,
and **leads** are one relation the scope service was never extended to.

All are tracked in the IRIS capabilities audit. Until they're closed, this recipe is the
workaround — which is why it leads with the warning rather than the happy path.

---

## Related recipes

- `bloq-relations.md` — linking bloqs into a project hierarchy
- `meetings.md` — filing call records onto a bloq (a common source of internal material)
- `pages.md` — publishing content deliberately, rather than as a side effect
