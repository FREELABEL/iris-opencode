---
category: Pages & Design
level: intermediate
tags: [pages, genesis, visibility, lead-capture, email-gate, funnel]
duration_min: 10
---
# Page visibility and the email/lead-capture gate

Two INDEPENDENT controls. Confusing them will either expose a page or silently kill a
client's lead capture.

| Control | What it does | Where it lives |
|---|---|---|
| **visibility** | who can REACH the url — public / unlisted / private | page column |
| **requires_auth** | the EMAIL GATE: visitors enter an email + 6-digit code before seeing content | page column |

A page can be `public` **and** gated. That is a normal, intentional combination — it is how a
public landing page captures every visitor's email before showing the funnel.

## Look before you touch

    iris pages visibility <slug>

    Visibility:  public
    Status:      ● Published
    Login gate:  on (requires_auth — visitors must sign in)

If the `Login gate:` line is absent, the gate is OFF.

## Set them

    # who can reach it
    iris pages visibility <slug> public       # discoverable, search-indexable
    iris pages visibility <slug> unlisted     # link-only, not discoverable
    iris pages visibility <slug> private      # locked down

    # the email / lead-capture gate  (page COLUMN, not json_content)
    iris pages set <slug> requires_auth true
    iris pages set <slug> requires_auth false
    iris pages cache-clear <slug>             # REQUIRED — the render is cached

## Traps that cost real time

**`iris pages visibility <slug> public` can CLEAR requires_auth.** Setting visibility is not
orthogonal in practice — it wrote the gate off on a page that was already public. Always
re-check with `iris pages visibility <slug>` afterwards, and restore with
`iris pages set <slug> requires_auth true` if you did not mean to remove it.

**`requires_auth` inside `json_content` is NOT the gate.** The gate is the page COLUMN.
Editing `json_content.requires_auth` and running `pages push` + `publish` changes nothing —
verified. Use `iris pages set`.

**Your own browser lies to you.** Chrome shares the `atlas_session` cookie across tabs and
profiles, so a gated page renders normally for anyone who has signed in once — including a
brand-new tab. A gated page looks ungated to you while every real visitor hits the form.
Check with a curl instead:

    curl -s https://<host>/p/<slug> | grep -o 'gateRequired&quot;:[a-z]*'
    curl -s https://<host>/p/<slug> | grep -c '<ComponentName>'   # 0 = content stripped

When the gate is on, the server STRIPS `content.components` entirely — an anonymous visitor
receives no page content at all, only the gate. So "components: 0" is the gate working, not a
broken page.

**A gate on a conversion page is often deliberate.** Before calling it a bug, ask. One client
gates their booking page ON PURPOSE: every prospective customer enters an email before reaching
the wizard, so an abandoned booking still leaves a lead. Removing it "to fix conversions"
destroys the capture they actually wanted.

## Which pages should be gated

- **Gated**: dashboards and anything reading tenant data (`app-data` returns 401 without the
  session), plus funnels where the client wants every visitor captured.
- **Not gated**: marketing, pricing, docs — anything meant to be found and shared.

If you are unsure, ASK THE CLIENT. The gate is a business decision about lead capture, not a
technical default.
