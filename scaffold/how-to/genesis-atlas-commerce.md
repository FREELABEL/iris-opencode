---
category: Finance
level: intermediate
tags: [commerce, payments, atlas, genesis, ledger]
duration_min: 15
---
# How to: Sell with Genesis, Atlas & Commerce — priced on the server, held, and on the ledger

## What this does

Puts a working **Buy** button on an IRIS page for things you already describe in a list —
service packages, workshops, fixed-price offers — without building a shop.

- Your catalogue is an **Atlas dataset**: one row per package. Edit it from the command line;
  the page follows.
- The page shows it with the **AtlasStorefront** component: cards, search, a Buy button each.
- Buy opens a hosted **Stripe checkout on the platform account**. The price is read from your
  dataset on the server at the moment of purchase — never from the page or the link.
- Every sale is written to an **append-only settlement ledger**: pending, paid, held, released,
  paid out — or refunded / disputed. Nothing in it can be edited; each entry is chained to the
  one before it, so a change anywhere is detectable.

## How the money moves

<svg viewBox="0 0 760 330" role="img" aria-label="Buyer clicks Buy, the server reads the price from Atlas, Stripe charges the platform account, the ledger records pending, paid, held, released, paid out" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="20" width="150" height="70" rx="10" style="fill:none;stroke:currentColor;stroke-opacity:.35"/>
<text x="85" y="50" text-anchor="middle" style="fill:currentColor;font-size:14px;font-weight:600">Your page</text>
<text x="85" y="72" text-anchor="middle" style="fill:currentColor;font-size:12px;opacity:.7">storefront + Buy</text>
<rect x="210" y="20" width="160" height="70" rx="10" style="fill:none;stroke:currentColor;stroke-opacity:.35"/>
<text x="290" y="50" text-anchor="middle" style="fill:currentColor;font-size:14px;font-weight:600">Atlas catalogue</text>
<text x="290" y="72" text-anchor="middle" style="fill:currentColor;font-size:12px;opacity:.7">price read on the server</text>
<rect x="420" y="20" width="150" height="70" rx="10" style="fill:none;stroke:currentColor;stroke-opacity:.35"/>
<text x="495" y="50" text-anchor="middle" style="fill:currentColor;font-size:14px;font-weight:600">Stripe checkout</text>
<text x="495" y="72" text-anchor="middle" style="fill:currentColor;font-size:12px;opacity:.7">platform account</text>
<rect x="620" y="20" width="130" height="70" rx="10" style="fill:none;stroke:currentColor;stroke-opacity:.35"/>
<text x="685" y="50" text-anchor="middle" style="fill:currentColor;font-size:14px;font-weight:600">Ledger</text>
<text x="685" y="72" text-anchor="middle" style="fill:currentColor;font-size:12px;opacity:.7">append-only</text>
<line x1="160" y1="55" x2="206" y2="55" style="stroke:currentColor;stroke-width:1.5"/>
<line x1="370" y1="55" x2="416" y2="55" style="stroke:currentColor;stroke-width:1.5"/>
<line x1="570" y1="55" x2="616" y2="55" style="stroke:currentColor;stroke-width:1.5"/>
<text x="10" y="140" style="fill:currentColor;font-size:13px;font-weight:600">What the ledger records for one sale</text>
<rect x="10" y="160" width="110" height="44" rx="22" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="65" y="187" text-anchor="middle" style="fill:currentColor;font-size:13px">pending</text>
<rect x="160" y="160" width="110" height="44" rx="22" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="215" y="187" text-anchor="middle" style="fill:currentColor;font-size:13px">paid</text>
<rect x="310" y="160" width="110" height="44" rx="22" style="fill:none;stroke:#c62f1a;stroke-width:2"/>
<text x="365" y="187" text-anchor="middle" style="fill:currentColor;font-size:13px;font-weight:600">held</text>
<rect x="460" y="160" width="120" height="44" rx="22" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="520" y="187" text-anchor="middle" style="fill:currentColor;font-size:13px">released</text>
<rect x="620" y="160" width="130" height="44" rx="22" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="685" y="187" text-anchor="middle" style="fill:currentColor;font-size:13px">paid out</text>
<line x1="120" y1="182" x2="156" y2="182" style="stroke:currentColor;stroke-width:1.5"/>
<line x1="270" y1="182" x2="306" y2="182" style="stroke:currentColor;stroke-width:1.5"/>
<line x1="420" y1="182" x2="456" y2="182" style="stroke:currentColor;stroke-width:1.5"/>
<line x1="580" y1="182" x2="616" y2="182" style="stroke:currentColor;stroke-width:1.5"/>
<text x="215" y="228" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.7">Stripe confirms</text>
<text x="365" y="228" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.7">automatic</text>
<text x="520" y="228" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.7">a person approves</text>
<text x="685" y="228" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.7">transfer to you</text>
<rect x="250" y="262" width="230" height="44" rx="22" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5;stroke-dasharray:5 4"/>
<text x="365" y="289" text-anchor="middle" style="fill:currentColor;font-size:13px">refunded or disputed</text>
<line x1="365" y1="236" x2="365" y2="258" style="stroke:currentColor;stroke-width:1.5;stroke-dasharray:4 4"/>
<text x="500" y="289" style="fill:currentColor;font-size:11px;opacity:.7">from paid or held, never after payout</text>
</svg>

## When to use it — and when not to

**Use it** when the price is the price: a fixed package, a workshop seat, a starter offer.

**Don't use it** for "starting at" prices or anything quoted per client. Buy charges the listed
amount. Send those to a contact form instead, and say so on the page.

## The short version

```bash
# 1. a catalogue
iris atlas:datasets schemas create --name studio-packages --slug studio-packages --bloq <workspace> --fields fields.json
iris atlas:datasets import packages.json -s studio-packages

# 2. visible to visitors, and open for sale (sellable is opt-in, never assumed)
iris atlas:datasets schemas update studio-packages --settings '{"public":true,"sellable":true}'

# 3. on the page — push AND publish together; a push alone leaves the page a draft
#    { "type": "AtlasStorefront", "props": { "datasetSlug": "studio-packages", "bloqId": <workspace>,
#      "returnUrl": "https://heyiris.io/p/<page>#packages", "sectionId": "packages" } }
iris pages push <page> && iris pages publish <page>
```

The full, runnable procedure — field definitions, the check that a buy link really reaches
Stripe, and what to do after a sale — is the **genesis-atlas-commerce** playbook:

```bash
iris playbook install genesis-atlas-commerce
```

## Rules the system enforces for you

| You might try… | What happens |
|---|---|
| Changing the price in the link | Ignored — the price comes from the dataset on the server |
| Selling a dataset you never marked sellable | Refused; the buyer returns to your page with "not available" |
| A row with `active: false`, no price, a monthly price, or a non-USD price | Not shown, and refused at checkout |
| Stripe sending the same event twice | Recorded once |
| A payment for a different amount than the listed price | Not recorded as paid; flagged |
| Releasing money without a reason | Refused — a release records who and why |
| Editing a ledger entry | Refused; an edit made underneath the app is caught by verification |

## What this does not do yet

- **Self-serve payment setup.** Who gets paid and the platform fee are switched on by the IRIS
  team for your workspace today.
- **Payouts.** Releases are recorded; the transfer to the seller is being built. The person being
  paid needs Stripe onboarding before a payout — not before a sale.
- **Subscriptions, other currencies, partial refunds.** One-time USD sales; partial refunds are
  flagged for a person.
