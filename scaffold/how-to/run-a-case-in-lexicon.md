---
category: CRM & Sales
level: beginner
tags: [legal, lexicon, law-firm, engagement, conflicts, signature]
duration_min: 10
---
# How to: Run a case in Lexicon

## What this does

Takes a new case from first enquiry to a signed engagement letter, then a chronology and a
demand draft. Lexicon does the assembling. Your attorneys make every decision.

**Lexicon is not a lawyer.** Everything it writes is a draft for a qualified person to review.
It does not clear conflicts on its own, and it does not choose a fee or a demand figure.

If your firm runs a practice platform such as Clio, that platform stays your system of record.

## Prerequisites

- `iris auth login` completed
- CLI **v1.5.33 or later** (`iris --version`). Older versions lack `--record` and `--cleared-by`, and their doors can fail with "Playbook not found"

---

## 1. Open the case

```bash
iris lexicon intake "Jane Roe called: rear-ended on I-35 on March 3, adverse driver insured by Acme" \
  --practice "personal injury" --open yes --record yes
```

Check the dates it flags against the source. A date marked `computed` is a prompt to check a
limitation period, not an authority. Note the case's lead id, which is the case id; the next steps use it, shown here
as `123`.

## Before your first case: load the parties you already know

A conflicts check can only find people and companies it has on file. Cases synced from Clio bring
their parties, including cases Clio closed years ago. Anyone else, from an old system or a
spreadsheet, goes in once as a CSV:

```csv
external_id,case_ref,name,role,counsel,carrier,notes
HIST-0001,HIST-2019-014,Jane Roe,client,,,Closed 2021
HIST-0002,HIST-2019-014,Northgate Freight LLC,adverse,Pat Lowe,Brazos Mutual,
```

```bash
iris atlas:datasets import parties.csv --schema lex-party --bloq <your firm board> --dry-run
iris atlas:datasets import parties.csv --schema lex-party --bloq <your firm board>
```

`external_id` must be unique and stable. Re-running the same file updates rows instead of adding
them again. `role` is `client`, `adverse`, `adverse_counsel`, `carrier`, `witness`, `provider`, `related` or `other`.

## 2. Check for conflicts

```bash
iris lexicon conflicts "Jane Roe" --also "Acme Insurance" --lead 123 --record yes
```

This surfaces candidates from your records. Names are matched as names, so "Roe, Jane",
"J. Roe" and "Jane Rowe" all reach "Jane Roe", and a party's counsel and insurer are checked too.
Each candidate is marked PROBABLE or POSSIBLE with the reason. It leans toward showing too much:
a false alarm costs a minute, a miss can cost the case.

A clean sweep says nothing surfaced in what was searched. It does not clear the conflict.

## 3. Record the attorney's clearance

Once an attorney has reviewed the sheet:

```bash
iris lexicon conflicts "Jane Roe" --lead 123 --cleared-by "Pat Partner"
```

Until this is recorded, an engagement letter on this case is refused.

## 4. Draft the engagement letter

```bash
iris lexicon engagement 123 --fee "contingency 33.3% pre-suit, 40% post-filing" --record yes
```

Without `--fee` it writes `[to confirm: fee arrangement]`. It does not include
jurisdiction-specific disclosures, so check its closing list. Have a person resolve every
`[to confirm: ...]`, then save the approved wording to a file such as `letter.txt`.

## 5. Send it for signature

```bash
iris lexicon agreements raise 123 --firm "Harlan PI" --name "Jane Roe" --email jane@example.com \
  --type engagement --body-file letter.txt --issue
```

**`--issue` emails the client.** Leave it off to keep a draft. The wording is sealed exactly as
supplied, including anything you forgot to resolve.

The same command sends other documents with `--type`: `fee`, `co_counsel`, `tolling`,
`settlement`, `release`, `letter_of_protection`, `medical_authorization`, `other`.

## 6. See where things stand

```bash
iris lexicon agreements list 123     # this case
iris lexicon agreements list         # every case
iris agreements show <id>            # one agreement, with its audit trail and seal check
```

The list counts how long each one has been waiting. `iris agreements issue <id>` re-sends it.

## 7. Build the chronology

```bash
iris lexicon chronology 123 --record yes
```

Read the channel breakdown first. A short chronology can mean a quiet case, or that nothing was
logged, and the output cannot tell you which.

## 8. Draft the demand

```bash
iris lexicon demand 123 --demand "185000 — specials 62k, 3x" --recipient "Acme Insurance" --record yes
```

Read the readiness verdict before the letter. **Not ready still produces a draft**, stamped do not
send. Without `--demand` the figure is left for the attorney. It cites no statute or case law.
Nothing here sends a demand to anyone.

---

## Troubleshooting

**`conflicts_not_cleared` when sending** — step 3 has not been recorded for this case.

**`document_required`** — only NDAs and BAAs have default wording. Pass `--body-file` or `--template`.

**The list is empty but agreements exist** — you may be signed in under a different account from
the one that raised them. Colleagues on the firm's board can see case agreements once they are
filed against a case on that board.

## Related

- [agreements-and-signing](agreements-and-signing.md) — signing, multi-party, audit trail and revoking in detail
