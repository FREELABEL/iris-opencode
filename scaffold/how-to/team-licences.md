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
  expires:  2027-01-29T12:00:00+00:00
  ────────────────────────────────────────────────────────────
Give the key to the buyer — they run: iris licence claim <key>
```

- `--days` is when access ends. Leave it out and the licence lasts one year. It must be at least 1.
- `--email` records who it was issued to. It does not limit who can claim the key.
- `--note` records what was agreed, in words.
- `--lead` must be a lead that exists. To add it later, use `iris licence link <key> --lead <id>`.

## Step 2: Send the key

Send it privately, with a link to `claim-a-licence`. The key is the access: anyone who has it can take a seat until the seats run out, so never put a multi-seat key on a public page.

Whoever claims first becomes the licence's owner. Each person proves their address with an email code when claiming on Desktop, or is already signed in when claiming from the terminal.

## Step 3: See who has claimed it

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

Add `--json` for the seat list. To see every licence, run `iris licence list`, which also includes revoked ones. Filter it with `--status active`.

## Step 4: End it early

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

**A team member's claim says there are no seats left.** Every seat is taken. Issue another licence for the people still waiting.

**Scripting these commands.** A failure or refusal exits non-zero. With `--json`, `issue`, `claim` and `revoke` print the result as JSON on stdout, failures included.

## Related

- `claim-a-licence.md`: what the people receiving the key do
- `lead-to-proposal.md`: from a lead to a signed deal
