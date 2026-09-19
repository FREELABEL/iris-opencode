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

## Four IRIS products, one sale

<svg viewBox="0 0 760 450" role="img" aria-label="Four IRIS products, one sale: Atlas holds your inventory, Genesis serves it on your page, Commerce creates the payment link, holds the money and pays you out, Mint keeps the books." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
<text x="95" y="30" text-anchor="middle" style="fill:currentColor;font-size:15px;font-weight:700">ATLAS</text>
<text x="95" y="48" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.65">your inventory</text>
<rect x="10" y="62" width="170" height="280" rx="12" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="285" y="30" text-anchor="middle" style="fill:currentColor;font-size:15px;font-weight:700">GENESIS</text>
<text x="285" y="48" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.65">your storefront</text>
<rect x="200" y="62" width="170" height="280" rx="12" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="475" y="30" text-anchor="middle" style="fill:currentColor;font-size:15px;font-weight:700">COMMERCE</text>
<text x="475" y="48" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.65">payment + payout</text>
<rect x="390" y="62" width="170" height="280" rx="12" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="665" y="30" text-anchor="middle" style="fill:currentColor;font-size:15px;font-weight:700">MINT</text>
<text x="665" y="48" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.65">your books</text>
<rect x="580" y="62" width="170" height="280" rx="12" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="24" y="88" text-anchor="start" style="fill:currentColor;font-size:10px;font-weight:600;opacity:.7;font-family:ui-monospace,Menlo,Consolas,monospace">package</text>
<text x="114" y="88" text-anchor="start" style="fill:currentColor;font-size:10px;font-weight:600;opacity:.7;font-family:ui-monospace,Menlo,Consolas,monospace">price</text>
<text x="160" y="88" text-anchor="start" style="fill:currentColor;font-size:10px;font-weight:600;opacity:.7;font-family:ui-monospace,Menlo,Consolas,monospace">on</text>
<line x1="22" y1="95" x2="168" y2="95" style="stroke:currentColor;stroke-width:1.5"/>
<text x="24" y="116" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">Starter</text>
<text x="114" y="116" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$297</text>
<text x="162" y="116" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">✓</text>
<text x="24" y="140" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">Launch</text>
<text x="114" y="140" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$2,000</text>
<text x="162" y="140" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">✓</text>
<text x="24" y="164" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">Retainer</text>
<text x="114" y="164" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$5,000</text>
<text x="162" y="164" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">✓</text>
<text x="24" y="188" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.55;font-family:ui-monospace,Menlo,Consolas,monospace">Old offer</text>
<text x="114" y="188" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.55;font-family:ui-monospace,Menlo,Consolas,monospace">$150</text>
<text x="162" y="188" text-anchor="start" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">✗</text>
<text x="95" y="236" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">one row = one thing</text>
<text x="95" y="252" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">you sell</text>
<text x="95" y="284" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">edit from the CLI</text>
<text x="95" y="300" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">or the app — no</text>
<text x="95" y="316" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">page edit needed</text>
<rect x="214" y="78" width="142" height="60" rx="8" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="226" y="100" text-anchor="start" style="fill:currentColor;font-size:12px;font-weight:600">Starter</text>
<text x="226" y="122" text-anchor="start" style="fill:currentColor;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace">$297</text>
<rect x="306" y="108" width="40" height="20" rx="10" style="fill:#c62f1a"/>
<text x="326" y="122" text-anchor="middle" style="fill:#ffffff;font-size:11px;font-weight:600">Buy</text>
<rect x="214" y="150" width="142" height="60" rx="8" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="226" y="172" text-anchor="start" style="fill:currentColor;font-size:12px;font-weight:600">Launch</text>
<text x="226" y="194" text-anchor="start" style="fill:currentColor;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace">$2,000</text>
<rect x="306" y="180" width="40" height="20" rx="10" style="fill:#c62f1a"/>
<text x="326" y="194" text-anchor="middle" style="fill:#ffffff;font-size:11px;font-weight:600">Buy</text>
<text x="285" y="236" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">rows appear on your</text>
<text x="285" y="252" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">page, with search</text>
<text x="285" y="284" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">a price change</text>
<text x="285" y="300" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">shows on the next</text>
<text x="285" y="316" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">page load</text>
<rect x="404" y="76" width="142" height="30" rx="15" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="475" y="95" text-anchor="middle" style="fill:currentColor;font-size:10.5px;font-family:ui-monospace,Menlo,Consolas,monospace">/buy/…/starter</text>
<line x1="475" y1="106" x2="475" y2="120" style="stroke:currentColor;stroke-width:1.5"/>
<rect x="404" y="120" width="142" height="30" rx="15" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="475" y="139" text-anchor="middle" style="fill:currentColor;font-size:11px">Stripe checkout</text>
<line x1="475" y1="150" x2="475" y2="164" style="stroke:currentColor;stroke-width:1.5"/>
<rect x="404" y="164" width="142" height="30" rx="15" style="fill:none;stroke:#c62f1a;stroke-opacity:1;stroke-width:2"/>
<text x="475" y="183" text-anchor="middle" style="fill:currentColor;font-size:11px;font-weight:600">held — fee kept</text>
<line x1="475" y1="194" x2="475" y2="208" style="stroke:currentColor;stroke-width:1.5"/>
<rect x="404" y="208" width="142" height="30" rx="15" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5"/>
<text x="475" y="227" text-anchor="middle" style="fill:currentColor;font-size:11px">payout to you</text>
<text x="475" y="284" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">price read on the</text>
<text x="475" y="300" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">server; released by</text>
<text x="475" y="316" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">a person, with a reason</text>
<text x="596" y="96" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.75;font-family:ui-monospace,Menlo,Consolas,monospace">pending</text>
<text x="736" y="96" text-anchor="end" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$297.00</text>
<text x="596" y="122" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.75;font-family:ui-monospace,Menlo,Consolas,monospace">paid</text>
<text x="736" y="122" text-anchor="end" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$297.00</text>
<text x="596" y="148" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.75;font-family:ui-monospace,Menlo,Consolas,monospace">held</text>
<text x="736" y="148" text-anchor="end" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$297.00</text>
<text x="596" y="174" text-anchor="start" style="fill:currentColor;font-size:11px;opacity:.75;font-family:ui-monospace,Menlo,Consolas,monospace">fee</text>
<text x="736" y="174" text-anchor="end" style="fill:currentColor;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace">$59.40</text>
<line x1="594" y1="194" x2="736" y2="194" style="stroke:currentColor;stroke-width:1.5"/>
<text x="596" y="214" text-anchor="start" style="fill:currentColor;font-size:11px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace">owed</text>
<text x="736" y="214" text-anchor="end" style="fill:currentColor;font-size:11px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace">$237.60</text>
<rect x="594" y="232" width="142" height="30" rx="15" style="fill:none;stroke:currentColor;stroke-opacity:.35;stroke-width:1.5;stroke-dasharray:5 4"/>
<text x="665" y="251" text-anchor="middle" style="fill:currentColor;font-size:11px">in iris mint</text>
<text x="665" y="284" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">every step is a new</text>
<text x="665" y="300" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">entry — nothing is</text>
<text x="665" y="316" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.75">ever edited</text>
<line x1="180" y1="202" x2="198" y2="202" style="stroke:currentColor;stroke-width:1.5"/>
<path d="M193 197 L200 202 L193 207" style="fill:none;stroke:currentColor;stroke-width:1.5"/>
<line x1="370" y1="202" x2="388" y2="202" style="stroke:currentColor;stroke-width:1.5"/>
<path d="M383 197 L390 202 L383 207" style="fill:none;stroke:currentColor;stroke-width:1.5"/>
<line x1="560" y1="202" x2="578" y2="202" style="stroke:currentColor;stroke-width:1.5"/>
<path d="M573 197 L580 202 L573 207" style="fill:none;stroke:currentColor;stroke-width:1.5"/>
<text x="195" y="372" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.8">Atlas serves the rows</text>
<text x="385" y="372" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.8">Buy opens the link</text>
<text x="575" y="372" text-anchor="middle" style="fill:currentColor;font-size:11px;opacity:.8">every sale is recorded</text>
<line x1="210" y1="420" x2="240" y2="420" style="stroke:currentColor;stroke-width:1.5"/>
<text x="248" y="424" text-anchor="start" style="fill:currentColor;font-size:11px">live today</text>
<line x1="360" y1="420" x2="390" y2="420" style="stroke:currentColor;stroke-width:1.5;stroke-dasharray:4 4"/>
<text x="398" y="424" text-anchor="start" style="fill:currentColor;font-size:11px">coming next</text>
<rect x="500" y="411" width="30" height="18" rx="9" style="fill:none;stroke:#c62f1a;stroke-width:2"/>
<text x="538" y="424" text-anchor="start" style="fill:currentColor;font-size:11px">money is held here</text>
</svg>

- **Atlas is your inventory.** One dataset, one row per thing you sell: name, price, whether it is on sale. You edit it from the command line or the app.
- **Genesis is your storefront.** The AtlasStorefront component reads those rows and shows them on your page, with search. Change a price in Atlas and the page follows — no page edit.
- **Commerce takes the money.** Every Buy is a payment link. The price is read on the server, Stripe collects it on the platform account, and it is **held** until a person releases it with a reason. The payout to you comes after that.
- **Mint keeps the books.** Every step of every sale is a new ledger entry — pending, paid, held, released, paid out — with the fee and what you are owed. Nothing is ever edited.

Everything solid is live today, including the payout: once a sale is released, `iris commerce payout` transfers the seller's share to their own Stripe account. The dashed box — your sales shown inside `iris mint` — is coming next.

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
- **Self-serve releases.** Releasing held money and paying out are done by the IRIS team today with
  `iris commerce release` and `iris commerce payout`; sellers can read their own sales with
  `iris commerce settlements --seller <workspace>`. The person being paid needs Stripe onboarding
  before a payout — not before a sale.
- **Subscriptions, other currencies, partial refunds.** One-time USD sales; partial refunds are
  flagged for a person.
