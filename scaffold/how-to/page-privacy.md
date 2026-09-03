# Page privacy — who can see a Genesis page, and how to lock one down

Written because an agent spent four commands and two minutes rediscovering this on a client's
machine, while the client watched, having already said she did not want her work public.

## The model, in one table

| what you want | command | result |
|---|---|---|
| look at a draft without exposing it | `iris genesis get <slug>` | prints the stored JSON. Proves the content landed. |
| let someone see a draft | `iris genesis preview <slug>` | a preview URL for an UNPUBLISHED page |
| let a specific person in, revocably | `iris genesis share <slug>` | a `/s/{token}` capability link. Works on drafts. Kill it with `iris genesis share:revoke <token>` |
| require login/OTP to view | `requires_auth = true` on the page | the OTP gate |
| take the public URLs away entirely | `iris genesis visibility <slug> private` | **both `/p/` urls go DEAD** — not delisted, dead. The only way in becomes a share link. |
| make it world-readable | `iris pages publish <slug>` | indexable by search engines. One-way in practice. |

## Two things that cost people time

**Privacy is TWO settings, not one.** `requires_auth = true` turns the login gate on.
`visibility private` removes the public URLs. They are independent — a page can require auth and
still be listed, or be unlisted and still open. If someone asks for "private", ask which they
mean, or set both.

**Changes need the cache purged before they take effect.**

    iris genesis cache-clear <slug>

Without it you will test the old state and believe the change did not work. This is the step
that makes the other two look broken.

## Never publish in order to inspect

`iris pages read <slug>` on a draft answers *"/p/ serves PUBLISHED pages only"* and suggests
`iris pages publish`. **Do not follow that.** It makes the page world-readable so you can look at
it — the wrong order when what you are checking for is an empty page.

On 2026-08-27 a page went out reading *"This page has no content yet."* It was the bug report
about pages shipping empty. Use `genesis get`.

## Default to the gated option

Most page content is work: client names, contact details, ticket links, internal notes. Offer
`preview` or a revocable `share` link first; publish LAST and only when the user says public.
Say what public means in their terms — *"readable by anyone with the link, and search engines can
index it"* — not *"I'll publish this."*

## Checking what you actually did

    iris genesis check-public <slug>      is it reachable without auth?
    iris genesis share:list <slug>        which share links exist, their views and expiry
    iris pages verify <slug> --expect "a phrase"    does the RENDER contain what you think
