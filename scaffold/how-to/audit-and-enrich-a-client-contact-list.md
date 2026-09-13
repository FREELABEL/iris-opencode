# Audit a client's contact list, then fill the gaps — without hand-researching every row

**Category:** data · **Level:** intermediate · **Time:** an afternoon for a few hundred records

Written from a real one: several hundred organisations out of a client's CRM, audited for
missing phone, email and website, enriched from the open web, and delivered as a workbook
their team could act on the next morning. **Cost: 22 search credits.** The naive version of
the same job would have spent roughly twenty times that, for a third of the coverage.

The saving is not a trick. It is one decision made early, and it is in step 4.

---

## The shape of the job

A client's CRM has records nobody has cleaned in years. Some have a phone, few have an email,
fewer have a website, and the team's plan is to have people call each one. You are replacing
"call every organisation" with "call the few we genuinely could not find".

Four phases: **pull · split · enrich · hand back.**

---

## 1 · Pull the data from the system of record, not from a screen

```
iris integrations exec <type> <function> key=value
iris integrations list                       # what is connected, and as whom
```

Two traps here, both of which have cost a day:

- **A record's contact detail often lives on a different entity than the record.** A record may carry a
  person's *name* while their phone and email sit on a separate contact entity you would have
  to click into, one at a time, in the UI. The API usually does not need to click — pull the
  contact entity directly and join. Check whether that entity exists before concluding a
  field is empty.
- **"Not connected" and "not visible to you" are different answers.** If a tool says an
  integration is missing while another surface plainly shows it, do not work around it.
  Report it, and say which command you ran — the command identifies which store answered.

---

## 2 · Split FA columns from AUDIT columns, on the way out

The single most useful structural decision. Two kinds of column:

| | |
|---|---|
| **FA / source columns** | exactly what the system of record holds. Never edited by hand. |
| **AUDIT columns** | what a human confirms, corrects or adds. |

Keep them side by side and never write enrichment into a source column. The moment those
merge, nobody can answer *"is this what the CRM says, or what someone typed?"* — and that is
the only question the cleanup exists to answer.

Add a **NEEDS COLLECTION** worklist: the rows with nothing to go on. That is the list the
team actually works from, and it is far shorter than the file.

---

## 3 · Know your ceiling before you promise coverage

Count what is *possible* before reporting what is *missing*. On the real run, one requested
field could only ever be populated for a minority of records — most source contacts simply
had no value in the field it was derived from. It was never going to reach 100%, and the
ceiling was knowable before a single lookup ran.

Say that in the report. A field at 40% with a stated ceiling is a finding. The same field at
40% with no ceiling reads as a broken export, and someone will spend a week trying to fix it.

---

## 4 · Enrich in the cheapest order — this is the whole saving

Do **not** hand the whole list to a web search. Sort by what each row already has:

| the row has… | do this | cost |
|---|---|---|
| a website, no email | **scrape the site directly** | **0 credits** |
| no website *and* no email | one web search, `search_depth: basic` | 1 credit each |
| only a missing phone | skip unless asked | 0 |

On the real run, roughly ten times as many rows were scraped for free as were searched, and
the remainder were deliberately skipped. **22 credits total.**

The version that burns your quota is `search_depth: advanced` across everything: **2 credits
per row**, applied to rows that mostly did not need a search at all. On a partial pass that
already came to more than twenty times the cost of the plan above. Basic depth is the default
for a reason; only reach for advanced when basic has actually failed on that row.

```
iris integrations connect tavily --field api_key=tvly-…
iris integrations exec tavily search query="…" search_depth=basic
```

**Use the client's own key.** Free tiers are ~1,000 credits/month, which is four runs of this
size. A shared platform key is one shared rate limit for everyone, and the per-tenant billing
question becomes unanswerable.

---

## 5 · Never guess a value into an audit

The rule that makes the output trustworthy: **leave it blank rather than fill it wrong.**

A blank cell costs someone a phone call. A plausible wrong email costs them a bounced demand
letter and a lost afternoon, and they will not know which cells to distrust — so they will
distrust all of them, and the whole workbook is worth nothing.

Record the interesting failures as *findings*, not gaps:

- an organisation that is **permanently closed** — say so in the website column instead of
  leaving it empty
- a **multi-location** organisation where you used the corporate contact rather than a branch
- a name that matched **two** organisations

---

## 6 · Hand it back where the team already works

```
iris atlas:datasets import <file.csv> -s <slug> --id-field <key>
iris bloqs items <bloq-id>
```

Version the workbook (v1.0, v1.1, v1.3) and put the links on the project item. Regenerating a
workbook **strips dropdown validations** — if the client added yes/no dropdowns, a rebuild
silently removes them. Rebuild *from* the source and re-apply the validations, or edit in
place.

Finish with a count that could have failed:

```
iris atlas:datasets aggregate -s <slug> -m count
iris atlas:datasets records list -s <slug> --limit 5
```

`records list` returns 25 rows unless you pass `--limit`, so counting its output measures the
page size, not the dataset. Take counts from `aggregate`.

---

## What "done" looked like

Near-total coverage on phone, roughly three quarters on email, under half on website — and,
more useful than any of those, an explicit named list of the rows that still needed a human.
22 credits. One workbook, versioned, on the project board.

The measure of done was not the percentages. It was that nobody had to research the gaps to
find out where they were.

---

## Related

- `iris how-to product-from-idea-to-published-page` — same session, the other half
- `iris playbook run live-meeting-to-build-pipeline` — the loop this sits inside
