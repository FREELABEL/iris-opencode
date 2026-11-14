---
category: Pages & Design
level: beginner
tags: [pages, genesis, sign-in, access, gate, otp, link, magic link, staff, invite, private pages, access-link]
duration_min: 5
---
# How to: Let someone open a gated page without the emailed code

## What this does

A gated page normally asks for an email address and a 6-digit code. A **personal sign-in link**
lets one named person skip the code: they click the link and they are in — as themselves, with the
role they already have. Everything they do is still recorded as them.

```
iris pages access-link …  ─▶  https://heyiris.io/p/<page>?access=…  ─▶  they click once
                                                                     ─▶  signed in for 30 days
                                                                     ─▶  the link is spent
```

What it protects:

- **One person, one use.** The first open exchanges the link for that person's normal sign-in and
  removes it from the address bar. Opened again — from history, a screenshot or a forwarded email —
  it does nothing.
- **It expires.** 24 hours by default; at most 7 days.
- **It replaces the code, never the role.** A link can only be made for someone who already has a
  role on the page's board. Nobody new gets in this way.
- **Revocable, and listed** — you can see who has an open link and cancel it.

## Before you start

- The page is gated (it asks for sign-in) and owned by your board.
- The person already has a role on that board (operator, admin, …). If they do not, give them one
  first — the command refuses otherwise.
- You own the board.

## Steps

**1. Make the link**

```bash
iris pages access-link <page> --email person@company.com
iris pages access-link <page> --email person@company.com --expires 3d --label "first login"
```

The link is printed **once**. Send it to that person only — whoever opens it first is signed in as
them.

**2. They click it**

They land on the page, signed in, with the link gone from the address bar. Their sign-in lasts 30
days like any other. When it runs out they can use the emailed code, or you send a new link.

**3. See and cancel links**

```bash
iris pages access-link:list <page>          # who, open / used / expired / revoked — never the link
iris pages access-link:revoke <id>          # it stops working at once
```

Revoking stops the link; a sign-in it already created is not ended.

## When it does not work

- **"has no role on this board yet"** — give the person a role first; a link never grants one.
- **They land on the sign-in screen** — the link was already used, expired or revoked, or it was made
  for a different board's page. Make a new one.
- **"Only the board owner can issue sign-in links"** — run it from the board owner's account.

## Good to know

- A sign-in link counts for **reading** gated pages. Money, signing and other sensitive actions
  still ask for the emailed code.
- For a page anyone may open, do not gate it: `iris pages ungate <page>`. For a public form whose
  submissions only your team reads, see `public-form-to-private-dataset`.
