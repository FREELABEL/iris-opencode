---
category: CRM & Sales
level: intermediate
tags: [crm, contracts, payments, billing, proposals]
duration_min: 15
prerequisites: [lead-to-proposal]
---
# How to: Send a proposal, contract and payment link to a lead

## What this does

One command turns a lead into a deal the client can close without you in the room: a **proposal
page** they accept, a **client services agreement** they sign, and a **Stripe checkout** they pay.
The deal closes itself once the contract is signed and the payment lands.

## Before you start

- `iris auth login` done
- The lead exists — `iris leads search "<name>"` and note the ID
- A **catalogue package** for what you are selling. The gate refuses to create without one
  (`package_required`): a payment that cannot say what was bought cannot be recorded.

## 1. Find or create the package

```bash
iris leads packages <bloq_id>
```

Nothing fits? Create one. `-b` defaults to **monthly**, so pass it every time — a one-off job
created without `-b one_time` becomes a monthly charge.

```bash
iris leads create-package <bloq_id> \
  -n "Website Build + Hosting & Management" \
  -a 250 -b monthly \
  -f "Rebuilt from your design,Hosting and SSL,Monthly updates" \
  -s "$(cat scope.md)"
```

The package's **scope** replaces whatever you pass to the gate with `-s`, and its **price**
replaces `-a`. Write the scope for the client: it is printed in full on the proposal and in the
contract they sign.

### Write a rich scope

The scope is **markdown**, rendered on the proposal page and again inside the contract, so the
agreement carries exactly what the client read. Keep it in a file and pass `-s "$(cat scope.md)"`.

- **Headings, lists and tables** — a deliverables table with a *Done when* column turns the scope
  into something both sides can check off.
- **Charts** — a ` ```mermaid ` fence draws a flowchart, site map or sequence diagram on the page.
  `flowchart LR` stays legible in the document column; a wide `flowchart TD` shrinks until it can't
  be read.
- **Drawings** — a ` ```svg ` fence embeds a hand-drawn figure (a before/after comparison, a
  timeline). It passes an allowlist: no scripts, no external links. To follow the page's light and
  dark theme, style shapes with these classes instead of colours: `sv-box`, `sv-bad` (a gap, red),
  `sv-good` (resolved, green), `sv-cap`, `sv-k`, `sv-v`, `sv-row`, `sv-mark`, `sv-bad-t`,
  `sv-good-t`, `sv-line`, `sv-head`, `sv-grid`, `sv-bar`, `sv-bar-launch`.

HTML typed into the scope is shown as text, never run.

## 2. Pick the deal shape

| Deal | How |
|---|---|
| One-time job, paid upfront | package with `-b one_time` |
| Retainer | package with `-b monthly`, gate with `--term <months>` |
| Retainer, part paid upfront | add `--deposit <percent>` — a share of the total, not extra |
| **Build fee plus monthly** | add `--setup-fee <amount>` — charged today, *on top of* the monthly |

**Deposit or setup fee is the choice that matters.** On a $250/mo × 12 retainer, `--deposit 50`
totals **$3,000**, with $1,500 of it paid today. `--setup-fee 1500` totals **$4,500**: $1,500 today,
then $250 a month. Using a deposit to stand in for a build fee charges the right money and writes
the wrong total into the contract.

A setup fee needs recurring billing and a single package. It is refused on one-time gates
(`setup_fee_requires_recurring`) and on selectable tiers (`setup_fee_not_supported_for_tiers`)
rather than silently dropped.

## 3. Create the gate

```bash
iris leads payment-gate <lead_id> \
  -p <package_id> -a <price> -s "see package" \
  --term 12 --setup-fee 1500 \
  --no-auto-remind
```

`-a` and `-s` are still required by the command even though the package overrides them.

**Reminders email the client.** Without `--no-auto-remind`, a reminder is scheduled to go out a
day after the gate is created, with day-3 and day-7 reminders behind it. Turn them off when you
want to hand the link over yourself; send one later with `iris deals remind <lead_id>`.

The command prints three URLs — **proposal**, **contract**, **Stripe**. Nothing has been sent yet.

There is one open gate per lead. Creating a second returns the existing proposal instead. To start
over: `iris leads delete-gate <lead_id> --force`. Deleting a gate kills all three of its links —
the proposal, the contract **and the payment link** — so nothing you sent earlier can still be
signed or paid.

### Change the scope without new links

```bash
iris leads update-gate <lead_id> -s "$(cat scope.md)"
```

This rewrites the scope on the proposal and in the contract **in place**. The links you already
sent keep working and show the new scope. It is refused (`scope_locked`) once the client has
accepted the proposal or signed the contract — at that point the words are what they agreed to.

## 4. Read it before the client does

Open the **contract** link. It records nothing until someone signs, so checking it is safe.
Confirm:

- the Scope of Work reads the way you would say it to the client
- Compensation shows the setup fee, the monthly × term, and the total over the term
- the Term runs to a real end date, with 30 days' notice on recurring deals

Be careful with the **proposal** link: it records its first view, including yours.

## 5. What the client does

1. **Proposal** (`/proposal/<token>`) — scope, investment, and *Accept Proposal* with their typed name.
2. **Contract** (`/sign/<token>`) — a Client Services Agreement with FreeLabel Inc. Typed name and a
   consent box; the time, IP address and browser are recorded.
3. **Pay** — Stripe checkout. With a setup fee they pay it today and the first monthly charge
   follows one billing cycle later.

They can pay before signing. The deal then waits on the signature.

## 6. Track it to close

```bash
iris leads deal-status <lead_id>    # signed? paid? all three URLs
iris deals list                     # every open gate
iris deals remind <lead_id>         # send the next reminder now
```

| Status | Meaning |
|---|---|
| `awaiting_both` | not signed, not paid |
| `awaiting_payment` | signed, not paid |
| `awaiting_contract` | paid, not signed |
| `deal_closed` | signed and paid — the gate completes and any remaining reminders are cancelled |

## Know before you send

- **Money lands in the platform Stripe account.** Gates created from the CLI or API do not route
  through a Stripe Connect account.
- **Changing the price afterwards does not change the checkout.** `iris leads update-gate` updates
  the proposal's numbers, but the Stripe price was fixed when the gate was created. For a new price,
  delete the gate and create a new one. The scope is different: it edits in place (see above).
- **Payment links refresh themselves.** A checkout link never expires; a stale Stripe session is
  replaced on click, in the same shape (one-time or subscription). It stops working only when its
  gate is deleted.
- **The service provider on the contract is FreeLabel Inc.**

## Common errors

| Error | Fix |
|---|---|
| `package_required` | Pass `-p <package_id>`. Create one with `iris leads create-package`. |
| `setup_fee_requires_recurring` | Setup fees ride on a subscription. For one-time work, put the fee in the amount. |
| `setup_fee_not_supported_for_tiers` | Use a single `-p`, not `--packages`. |
| "A payment gate already exists" | `iris leads deal-status <id>` shows it; `iris leads delete-gate <id>` replaces it. |
| A one-off job shows `/month` | The package was created without `-b one_time`. Create a new package. |
| `scope_locked` | The client has accepted or signed. Revised terms need a new gate. |
| A chart shows as code | The fence must be exactly ` ```mermaid ` and the diagram must parse; an invalid chart is left as its source rather than an empty box. |
| A drawing is missing | The ` ```svg ` fence was refused by the allowlist (a script, an external link, or no `<svg>` root). Refused drawings render as nothing, never as raw markup. |

## Related recipes

- `lead-to-proposal.md` — the whole path from first conversation to paid
- `deals.md` — the pipeline after creation: reminders, win-back, heartbeat recovery
- `agreements-and-signing.md` — NDAs and BAAs, which gate access rather than sell
