---
category: CRM & Sales
level: intermediate
tags: [licence, license, key, seats, team, grant, operator, revoke]
duration_min: 10
---
# How to: Give a team IRIS access with one licence

## What this does

Issue one licence key with enough seats for a whole team, send it to them, and see who has claimed it. Each person claims the same key with their own account. These commands are for IRIS operators.

## Before you start

- An IRIS operator account. Anyone else gets `not found` from `issue`, `list`, `show`, `link` and `revoke`, and the command says so.
- The team's headcount and how long the grant should last.
- The ID of the CRM lead this grant belongs to, if there is one.

## Step 1: Issue the key

Set seats to the whole team's headcount, not just the first person.

```bash
iris licence issue --email ops@example.com --tier pro --seats 14 --days 90 --note "Acme team, 90 days" --lead 4821
```

```
◈  Licence issued
  ────────────────────────────────────────────────────────────
  key:  IRIS-7XKM-4QPT-9HRW
  tier:  pro
  seats:  14
  allowance:  $0.00 per month, shared by 14 seat(s)
  seat cap:  none
  expires:  2027-01-29T12:00:00+00:00
  ────────────────────────────────────────────────────────────
Name the people: iris licence invite <key> <email...>   ·   then: iris licence send <key> <email...>
```

- `--days` is when access ends. Leave it out and the licence lasts one year. It must be at least 1.
- `--email` records who it was issued to. It does not limit who can claim the key.
- `--note` records what was agreed, in words.
- `--lead` must be a lead that exists. To add it later, use `iris licence link <key> --lead <id>`.

## Step 2: Decide what limits spend

An allowance is not a spending limit. `--allowance` sets a monthly pool, in cents, shared by every seat. When the pool runs out, nobody is stopped: each person keeps working and spending up to the caps of the licence's tier.

| Tier | Per person, per day | Per person, per month |
|---|---|---|
| `starter` | $5 | $50 |
| `pro` | $25 | $250 |
| `business` | $50 | $500 |

Only `--seat-cap` stops a seat sooner. It sets a monthly limit, in cents, for each seat. A seat at its limit is refused while the others carry on.

```bash
iris licence issue --email ops@example.com --tier pro --seats 14 --days 90 --allowance 10000 --seat-cap 2000
```

```
  allowance:  $100.00 per month, shared by 14 seat(s)
  seat cap:  $20.00 per seat per month
  pool runs out:  seats keep working and spending, until a seat reaches its $20.00 monthly seat cap or its plan tier's caps
```

Leave out `--seat-cap` and `issue` warns you. With `--json`, the same text is in a `warning` field:

```
The $100.00 allowance is not a spending limit. Spend can go past it, up to each seat's plan tier caps. Only a seat cap (--seat-cap) stops a seat sooner.
```

To work out the most a licence can cost in a month, multiply the seat cap by the seats: here, $20 x 14 = $280, not $100. Allow a little over that. The limit is checked before each model call, so a call already running finishes, and a refusal can lag by up to a minute. `issue` is the only command that sets a seat cap.

## Step 3: Send the key

Send it privately, with a link to `claim-a-licence`. The key is the access: anyone who has it can take a seat until the seats run out, so never put a multi-seat key on a public page.

Whoever claims first becomes the licence's owner. Each person proves their address with an email code when claiming on Desktop, or is already signed in when claiming from the terminal.

## Step 4: See who has claimed it

```bash
iris licence show IRIS-7XKM-4QPT-9HRW
```

```
◈  IRIS-7XKM-4QPT-9HRW
  ────────────────────────────────────────────────────────────
  tier:  pro
  status:  active
  seats:  3 of 14 held
  issued to:  ops@example.com
  lead:  #4821
  ────────────────────────────────────────────────────────────
  2026-10-31T12:00:00  issued
  2026-10-31T12:09:41  claimed
iris licence show <key> --json for everything
```

On a licence with an allowance, `show` also prints this month's pool and what happens when it runs out. Add `--json` for the seat list. To see every licence, run `iris licence list`, which also includes revoked ones. Filter it with `--status active`.

## Step 5: End it early

A licence ends by itself on its expiry date. To end it sooner:

```bash
iris licence revoke IRIS-7XKM-4QPT-9HRW
```

```
Revoked IRIS-7XKM-4QPT-9HRW
```

Revoking ends access for everyone on the licence. Its seats and history are kept. Running it again changes nothing and writes nothing to the history:

```
IRIS-7XKM-4QPT-9HRW was already revoked
```

## Common problems

**`The days must be at least 1.`** `--days 0` is refused rather than turned into a default. Leave `--days` out if you want the one-year default.

**`The selected lead id is invalid.`** That lead does not exist. Check the ID, or issue without `--lead` and link it later.

**`not found — this is also what a non-operator sees`.** Either the key is wrong or your account is not an operator.

**Spend went past the allowance.** That is how an allowance works. See Step 2.

**A team member's claim says there are no seats left.** Every seat is taken. Issue another licence for the people still waiting.

**Scripting these commands.** A failure or refusal exits non-zero. With `--json`, `issue`, `claim` and `revoke` print the result as JSON on stdout, failures included.

## Related

- `claim-a-licence.md`: what the people receiving the key do
- `lead-to-proposal.md`: from a lead to a signed deal
