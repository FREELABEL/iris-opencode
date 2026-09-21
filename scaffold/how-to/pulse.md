---
category: CRM & Sales
level: beginner
tags: [crm, pulse, reporting]
duration_min: 10
---
# How to: score every account with Pulse, and know which one needs you today

## What this does
Pulse gives each of your accounts a single number out of 100, recomputed automatically, built
from things that are actually true: your automated checks are passing, your agents are alive,
somebody replied to an email recently, the setup is finished. You get a daily email with the
score and what moved, and one command that ranks your whole book worst-first.

It answers the question you cannot answer from a CRM stage: **which client is quietly going
wrong, and what do I do about it before they notice.**

## Prerequisites
- The IRIS CLI, signed in — `iris auth login`
- At least one account in your CRM — `iris leads create`, or one you already have
- Optional, for the reply-freshness part of the score: your machine connected to IRIS, so your
  email and messages can be counted — `iris hive connect`, then `iris-daemon status`

## 1. Tell Pulse what "working" means for this client

A **requirement** is an automated check against something you deliver — their booking page
returns 200, a form actually submits, a nightly job ran. Adding the first one enrolls the
account in Pulse.

```bash
iris leads requirements create <lead_id> \
  --name "Booking page returns 200" \
  --severity high \
  --frequency-minutes 60 \
  --script-content "$(cat ./check-booking-page.js)"
```

- **Severity** is how much a failure hurts the score: `blocker` counts 4×, `high` 3×,
  `medium` 2×, `low` 1×.
- **`--frequency-minutes`** runs it on a schedule. Leave it off to only run it by hand.

Checks run on your own machine through Hive, so a check can reach things only you can reach.

## 2. Read the score

```bash
iris leads pulse <lead_id>
```

```
Pulse:    72/100  attention
Trend:    ▁▃▄▆█  (8 snapshots)
Signals:  req 80/100 · live 100/100 · comms 60/100 · cfg 75/100
```

The trend is the last 8 recorded scores, oldest on the left. It appears once there are two.

## What the number is made of

<svg viewBox="0 0 720 200" width="100%" height="auto" role="img" aria-label="Weighting of the six Pulse signals: requirements 35 percent, liveness 20, replies 18, setup 13, deal health 7, meetings 7" style="max-width:720px;margin:1rem 0">
  <g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="currentColor">
    <text x="0" y="24">your checks passing</text><text x="700" y="24" text-anchor="end">35%</text>
    <text x="0" y="54">agents alive</text><text x="700" y="54" text-anchor="end">20%</text>
    <text x="0" y="84">someone replied recently</text><text x="700" y="84" text-anchor="end">18%</text>
    <text x="0" y="114">setup finished</text><text x="700" y="114" text-anchor="end">13%</text>
    <text x="0" y="144">deal in order</text><text x="700" y="144" text-anchor="end">7%</text>
    <text x="0" y="174">meetings happening</text><text x="700" y="174" text-anchor="end">7%</text>
  </g>
  <g fill="currentColor">
    <rect x="215" y="12" width="437" height="14" rx="3" opacity="0.85"/>
    <rect x="215" y="42" width="250" height="14" rx="3" opacity="0.72"/>
    <rect x="215" y="72" width="225" height="14" rx="3" opacity="0.6"/>
    <rect x="215" y="102" width="162" height="14" rx="3" opacity="0.48"/>
    <rect x="215" y="132" width="87" height="14" rx="3" opacity="0.36"/>
    <rect x="215" y="162" width="87" height="14" rx="3" opacity="0.36"/>
  </g>
</svg>

| Signal | What makes it go up |
|---|---|
| **Your checks passing** (35%) | requirements that pass, weighted by severity |
| **Agents alive** (20%) | the agents working this account have reported in within 2 hours |
| **Someone replied recently** (18%) | an inbound email or message: under 7 days is full marks, under 30 days is partial, outbound-only counts for little |
| **Setup finished** (13%) | integrations connected, and a profile of the tools in use |
| **Deal in order** (7%) | proposal, contract, payment set up and received |
| **Meetings happening** (7%) | a meeting in the last or next 7 days scores full |

A signal with nothing to measure yet (a new account with no agents) drops out, and the rest
are re-weighted. It never counts as zero — a score you have not earned is not the same as a
score you have failed.

## 3. Run the checks now, instead of waiting

```bash
iris leads requirements run <lead_id> <requirement_id>   # one check
iris leads requirements run-all <lead_id>                # every check on this account
```

## 4. Rank your whole book, worst first

```bash
iris leads pulse-all
```

Every account with its score, and — where you take payment through IRIS — what they pay, when
the next payment is due, and who has no subscription yet.

```bash
iris leads pulse-all --prepare
```

The same list sorted worst-first, and for each account the three commands that would raise its
score the most:

```
#10061  Example Client D  51/100
        Tasks: 32 overdue · 72 pending  |  Checks: 0/2 passing  |  0/8 knowledge base
        1. iris leads kb 10061 --generate
        2. iris leads requirements run 10061
        3. iris leads content-engine create 20119
```

Narrow it when you want one slice:

```bash
iris leads pulse-all --status "In Negotiation"
iris leads pulse-all --bloq <bloq_id>
iris leads pulse-all --json | jq '.summary'     # for your own reporting
```

## 5. Get it by email every morning

Once an account has at least one check, you get a daily digest at 8 AM Central: the score, what
each signal contributed, what happened in the last 24 hours, and a link to the dashboard. There
is nothing to switch on.

## 6. Send the client a status update

```bash
iris leads pulse <lead_id> --recap --dry-run              # read it first
iris leads pulse <lead_id> --recap --to you@company.com   # send it to yourself
iris leads pulse <lead_id> --recap                        # send it to the client
```

Written from what actually happened on the account — what shipped, what is next, what you need
from them. It never mentions pricing or payments, so it is safe to send to the person who is
not paying the invoice. Once every 72 hours per account unless you pass `--force`. Add
`--recap` to `pulse-all` to do the whole book at once, and always preview with `--dry-run`.

## Gotchas

**A won deal that shows nothing.** `pulse-all` lists won accounts by default. If a paying client
is missing, their stage is probably still "In Negotiation":

```bash
iris leads search "Client Name"
iris leads update <id> --status Won
```

**The reply-freshness signal sits at zero.** That signal counts real email and messages, which
needs your machine connected: `iris hive connect`, then `iris-daemon status`. Without it the
signal drops out and the other five are re-weighted — the score is still valid, it just cannot
see conversations.

**You upgraded the CLI and checks went quiet.** The background service still holds the old
version: `iris-daemon restart`.

**The trend line is empty.** It needs two recorded scores. A score is only recorded when it
CHANGES, so a healthy, stable account records rarely — that is the intent, not a fault.

## What to do with the number

Pulse is only worth having if it changes what you do on a Monday. The useful habit is short:
open `iris leads pulse-all --prepare`, take the worst two accounts, run the three commands it
suggests for each, and send a recap to any client who has not heard from you in a fortnight.
The score climbing is the evidence you can show them — and the drop is the warning you get
before they go quiet.
