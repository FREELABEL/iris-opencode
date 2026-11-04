---
category: Data & Atlas
level: intermediate
tags: [atlas, datasets, forms, intake, referrals, public, submissions, lead capture, write-only, pages, genesis, honeypot, rate limit]
duration_min: 10
---
# How to: Let a public form add records to a private dataset

## What this does

A public page — a referral form, an application, an enquiry — saves each submission straight into
one of your datasets. The sender needs no account and no code. Your team reads the submissions on a
signed-in page; the public can only **add**. Nothing is ever read back through the form.

```
  public page  ──POST──▶  your dataset (private)  ──▶  your signed-in staff page
  (anyone)       write-only, one record          (only your team reads it)
```

What the server guarantees, whatever the form sends:

- **Only your fields** — keys the dataset does not declare are dropped.
- **Your values win** — fields you mark as "always set" (a stage, a status) cannot be chosen by the sender.
- **Write-only** — the reply is the new record's id and a reference number, nothing else.
- **Yours only** — a lane is found from YOUR published page and writes only into YOUR dataset.
- **Guarded** — a hidden honeypot field for bots, a check on which site is posting, size caps, and rate
  limits per sender and per hour (with ceilings no setting can raise).

## Before you start

- A dataset for the submissions (`iris datasets schemas create …`). Mark the personal fields
  `visibility: phi` or `private`.
- A **published** page owned by your board — the lane is addressed under it. It is usually the staff
  page that will list the submissions.

## Steps

**1. Turn the lane on**

```bash
iris datasets public-submit enable referrals \
  --page intake-desk --collection submissions \
  --require first_name,last_name \
  --set stage=New --set review_status=new \
  --ref-prefix INTAKE
```

- `--require` — at least one of these must be filled, or the submission is refused. Always set this;
  without it an empty submission would be saved.
- `--set field=value` — written by the server on every submission. The sender cannot change it.
- `--alias old=field` — accept an older field name from an existing form.
- `--origin example.com` — another site allowed to post (the same site and heyiris.io always are).
- `--per-sender` / `--per-hour` — limits (5 per address per 10 min and 200 per hour by default).

Add `--dry-run` to see exactly what would be stored first. A field name the dataset does not have is
refused — the server would silently drop that data.

**2. Prove it answers**

```bash
iris datasets public-submit test referrals
```

This sends a probe the server recognises as a bot and drops: a live lane answers in a few hundred
milliseconds and **saves nothing**.

**3. Point your form at it**

The form posts JSON to `https://heyiris.io/api/v1/app-data/<page>/<collection>`. `enable` prints a
copy-paste `fetch()`; in short:

```js
fetch("/api/v1/app-data/intake-desk/submissions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ first_name, last_name, notes, website /* hidden honeypot input */ }),
}).then((r) => r.json()).then((b) => b.success && show("Received: " + b.data.submission_ref))
```

Include a hidden input named `website` (off-screen, `tabindex="-1"`, `autocomplete="off"`). People never
fill it; bots do, and the server answers them like a success and saves nothing.

Show the `submission_ref` **from the reply** — it is the reference your team will see.

**4. Keep the form page public**

```bash
iris pages ungate <form-page>
iris pages check-public <form-page>
```

The **form** page is public; the **staff** page that reads the dataset stays signed-in. If
`publish-html` or `pages set` reports the gate as "half", run `iris pages ungate` — a page asking for
sign-in without a code loops.

**5. Read the submissions**

On your signed-in staff page, read `GET /api/v1/app-data/<page>/<collection>` — the same address,
read with a staff session. Anyone signed out gets 401.

## Check it / turn it off

```bash
iris datasets public-submit show referrals      # where it posts, what it accepts, the limits
iris datasets public-submit disable referrals   # stop accepting; the settings are kept
```

## Good to know

- Changing a lane cuts a new schema version (settings changes always do). Submissions keep flowing.
- `enable` merges into the dataset's settings — other settings (an onboarding flow, a row policy) are
  kept. Do not hand-edit with `schemas update --settings`: that replaces every setting at once.
- A signed-in member of your board who submits is recorded as who entered it; anyone else is
  recorded as the public.
