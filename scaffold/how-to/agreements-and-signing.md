# How to: Raise, send and sign an NDA or BAA — and gate access on it

## What this does

Agreements are the instruments that decide **whether someone is allowed to do the work**: an
NDA before they see anything confidential, a BAA before they touch protected health
information. This recipe covers raising one, getting it signed, reading the evidence
afterwards, and wiring it to an access decision so it means something.

**This is not the same thing as `payment-gate-contracts.md`.** That recipe sells: a scope of
work, a proposal page, an invoice and a Stripe checkout. This one gates: nobody is being
billed, and the signature is a precondition for access rather than a step toward payment. If
the question is "how do I get paid", read that one. If it is "may this person see this",
read this one.

## Prerequisites

- `iris auth login` completed
- CLI **v1.3.166 or later** (`iris --version`) — the agreements commands do not exist before it

---

## Know before you send anything

Three facts that are not obvious from any command's help text, and one of them is legal.

### 1. The signing link is a bearer credential

Anyone holding the URL can sign. There is no login in front of it, deliberately — the
counterparty has no account and making them create one before they can read what they are
agreeing to is backwards. The page says so to the signer in plain words.

That standard is fine for an NDA between people who already know each other. **It is not
sufficient for a BAA**, which is why a BAA additionally requires an emailed one-time code
(see *Signing a BAA* below). Never paste a signing link into a shared channel.

### 2. The clause wording has not been reviewed by a lawyer

Every template ships with `[PLACEHOLDER TEXT — pending counsel review]` on the face of the
document. Structure is production; wording is not. Do not issue one as a binding instrument
until the text has been replaced. The marker should be removed only by whoever replaces it.

### 3. `--owner` decides who can ever see it again

The ledger is scoped to the owner. An agreement filed under the wrong account is invisible to
the person responsible for chasing it — this happened, to six real agreements including one a
real person had signed. `--owner` is required for that reason.

---

## Quick path — raise, issue, watch

```bash
# Raise it and email the signing link in one step
iris agreements raise \
  --name="Dana Whitfield" \
  --email="dana@example.com" \
  --org="Independent researcher" \
  --disclosing="IRIS Labs" \
  --subject="engagement:dana-whitfield" \
  --term="two years" \
  --issue

# What is outstanding, and for how long
iris agreements list

# One agreement, with its full audit trail and seal verification
iris agreements show 4433
```

`--issue` emails the counterparty. Without it the agreement stays a draft and **is not
signable** — a link to a draft cannot execute it.

`--term` and the expiry date are two statements of the same fact, so the date is derived from
the term. `--term="two years"` expires in two years. A term the command cannot read
("for the duration of the engagement") is refused rather than guessed — pass
`--expires=YYYY-MM-DD` instead.

---

## The three layers, and why the split matters

```
contract_templates   the BODY        clauses + merge fields
atlas_records        the INSTANCE    who, status, expiry — ordinary app data, editable
audit_events         the EXECUTION   sent · opened · consented · signed · sealed
                                     hash-chained, append-only, tamper-evident
```

An Atlas record can be edited; an executed agreement is evidence. So the row carries the
**current state**, and a pointer into the chain that carries the **proof**. The document body
is hashed at execution, so a later edit to the stored text no longer matches the sealed hash
and the tampering becomes visible:

```bash
iris agreements show <id>      # reports the seal as `intact` or MISMATCH, never just the hash
php artisan audit:verify       # walks the whole chain; exit 0 OK, 1 TAMPERED, 2 UNVERIFIABLE
```

`audit:verify` reports **unverifiable** rather than OK when it cannot check. "We could not
check" must never read as "we checked and it is fine".

---

## Multi-party — two sides, two links

Most real agreements are two-sided. Pass `parties` and each side gets **their own link**;
a link signs for exactly one party.

```bash
# Over the API — the CLI takes a single counterparty today
curl -X POST -H "Authorization: Bearer $IRIS_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "agreement_type": "nda",
    "signing_order": "sequential",
    "subject_ref": "engagement:acme",
    "term": "one year",
    "parties": [
      {"role": "Provider",  "name": "Dana Whitfield",  "email": "dana@example.com"},
      {"role": "IRIS Labs", "name": "Alexander Mayo",  "email": "alex@freelabel.net"}
    ],
    "issue": true
  }' https://raichu.heyiris.io/api/v1/agreements

# Every party's link, with role and status
iris agreements link <id>
```

What to expect:

| | |
|---|---|
| **Sequential** (default) | Counter-signature. Party 2 cannot sign until party 1 has, and only party 1 is emailed until then. Out of turn returns **409 `not_your_turn`**, naming who they are waiting on. |
| **Parallel** | Either order. Everyone is emailed at once. |
| One of two signed | Status is `partially_signed`. **Nothing is sealed**, and the access gate stays shut. |
| Last party signs | Sealed **once**, over the body, and the agreement becomes `executed`. |
| Any party declines | The agreement is `declined` and ends. It is not a document waiting on the other side. |

---

## Signing a BAA — the extra step

A BAA, or anything at the `phi` access tier, requires proven control of the counterparty's
mailbox before it can be signed. Attempting to sign without it returns **428
`verification_required`**.

The code goes to the address **on the agreement**, never one the caller supplies — otherwise
the holder of the link verifies themselves and the check proves nothing. The signer clicks
*Send code*, receives a 6-digit code (10 minutes, single use, 5 attempts), enters it, then
signs. The sealed record stores the method as `typed-verified` rather than `typed-link`, so
the two standards stay distinguishable forever.

---

## Gating access on it

This is the point of the whole system. `AgreementService::gate()` answers *may this subject
proceed, right now*:

| Tier | Requires |
|---|---|
| `standard` | executed NDA |
| `phi` | executed NDA **and** BAA |

It is evaluated **continuously**, never cached to a boolean. An agreement that expires in June
closes the gate in July without anyone running a job. Revoking a BAA shuts it on the very next
call.

Wired today to Bounty OS admission: acceptance still happens (you routinely accept someone and
*then* send paperwork), but **assignment to a client project** is what the gate holds. The API
response says so — *"Application accepted — assignment withheld pending agreements"* — with
the missing list.

```bash
# Withdraw access that agreements no longer support. Dry by default.
php artisan agreements:sweep-access
php artisan agreements:sweep-access --apply
```

Exits non-zero when something has lapsed, so it can be scheduled and page someone. Without it,
"revoking a BAA closes the gate" is true and useless — the gate closes and the person stays on
the project.

---

## Revoking

```bash
iris agreements revoke <id> --reason="engagement ended"
```

The reason is **required**. A revocation withdraws access someone was relying on, and the chain
should say why without anyone reconstructing it from a timestamp. If you omit `--reason` the
command prompts rather than defaulting to something bland.

---

## What it refuses to do, and why

These are features, not bugs. If one of them surprises you, the surprise is the point.

| Refusal | Reason |
|---|---|
| Sign without ticking consent | ESIGN/UETA wants consent to transact electronically as its own act, **before** the signature it enables. Consent that follows its signature is not consent. |
| Sign under a name that is not the party's | A typed name belonging to someone else is not a signature by the party named in the document. |
| Mark executed if the seal did not reach the chain | An execution we cannot evidence is worse than one that did not happen. |
| Sign a draft | A link to something never issued must not be able to execute it. |
| Re-issue an executed agreement | It would send the counterparty to a link that refuses them. |
| Open a gate on an unknown tier | Falling through to an empty requirement list returns `permitted: true` — the most dangerous way for a gate to fail. |

---

## Troubleshooting

**`--owner is required`** — deliberate. The ledger is scoped to the owner and an agreement
filed under the wrong account is invisible to whoever has to chase it. Pass `--owner=<user id>`
or set `AGREEMENTS_DEFAULT_OWNER_ID`.

**The signing link 404s** — check it is the *party's* link, not the record's. On a multi-party
agreement use `iris agreements link <id>`, which prints one URL per party.

**`iris agreements list` is empty but you know agreements exist** — they are almost certainly
owned by a different account. `php artisan agreements:reassign --from=<a> --to=<b>` moves them,
audits the move, and verifies the seal before and after.

**`cannot sign without recorded consent`** — the API was called without `consent: true`. The
signing page ticks it; a direct API call must send it.

**428 `verification_required`** — it is a BAA or `phi` tier. Send and confirm the emailed code
first.

**Email did not arrive** — issuing records the delivery outcome either way. `iris agreements
show <id>` will say whether it was actually emailed or only marked sent.

---

## See the whole thing run

```bash
php artisan agreements:demo
```

Ten beats end to end, **including the refusals** — signing without consent, PHI without a BAA,
a body edited after execution, a revoked BAA closing the gate. A passing test renders a refusal
identically to a feature that was never built, which is why the demo exists.

## Related

- `payment-gate-contracts.md` — selling: proposal, invoice, Stripe checkout
- `bloq-access-control.md` — sharing a board without leaking it
- Epic #179757 · design standard at `/p/design-philosophy-and-page-audit`
