---
category: Content & Media
level: beginner
tags: [campaigns, ads, ad creatives, approvals, review, approve, reject, request changes, marketing, brand, content approval]
duration_min: 10
---
# How to: Run an ad campaign on your board — creatives, approvals, who decided when

## What this does

`iris campaigns` keeps a brand's ad campaigns on **the brand's own board**: each campaign, every
ad (creative) in it, and a review decision on each one — approved, rejected, or sent back for
changes — with **who decided and when** recorded on the creative.

```
iris campaigns setup  ─▶  create "Spring launch"  ─▶  add-creative × n  ─▶  approve | reject | request-changes
                                                                          ─▶  list: every state, who, when
```

What it promises:

- **Your board, your data.** Everything lives in four datasets on your board — `campaign`,
  `campaign-creative`, `campaign-feedback`, `campaign-template`. Another brand on IRIS never sees
  them, and you never see theirs.
- **The board decides who may do what.** The board's owner and members can read. The owner and
  editors of the whole board can set up, create, add creatives and review. Viewers can read only.
- **A review is a record, not a post.** Approving never publishes anything. When you are ready to
  post an approved creative, that is a separate, deliberate step: `iris post`.
- **A rejection says why.** `reject` needs `--reason`, `request-changes` needs `--note`. The note
  goes on the creative for whoever made it.

## Prerequisites

- Signed in: `iris auth whoami` (if not, `iris auth login`).
- A board you own or edit. Find its id: `iris bloqs list`.

## Steps

1. Set the board up (safe to run again — it only adds what is missing):

   ```
   $ iris campaigns setup --bloq 912
   ```

   It makes the four datasets and reserves your review page's address
   (`https://heyiris.io/p/<board>-campaigns`).

2. Start a campaign:

   ```
   $ iris campaigns create "Spring launch" --bloq 912 --objective sign-ups --channels instagram,x --budget 500
   ```

   `--budget` is in dollars. `--starts` / `--ends` take `YYYY-MM-DD`. The owner defaults to you.

3. Add creatives (each starts as a draft; `--submit` sends it straight to review):

   ```
   $ iris campaigns add-creative 4211 --bloq 912 --headline "Book in 30 seconds" --text "No calls, no forms." --image https://…/a.png
   $ iris campaigns add-creative 4211 --bloq 912 --headline "Three reasons" --slides https://…/1.png,https://…/2.png --submit
   ```

   Other fields: `--text-x` (a shorter caption for X), `--video`, `--poster`, `--landing-url`,
   `--utm-content`, `--product`, `--concept`, `--tags`, `--ad-no`, `--ab-pair`, `--hypothesis`,
   `--notes`.

4. Review them:

   ```
   $ iris campaigns approve 5120 --bloq 912
   $ iris campaigns reject 5122 --bloq 912 --reason "Off-brand colours"
   $ iris campaigns request-changes 5123 --bloq 912 --note "Shorter headline"
   ```

   Add `--score 1-5` to keep a score with the review.

5. See where everything stands:

   ```
   $ iris campaigns list --bloq 912
   $ iris campaigns show 4211 --bloq 912        # one campaign, with every review
   $ iris campaigns list --bloq 912 --json      # for scripts and agents
   ```

## Expected output

```
#4211  Spring launch  draft · Test Brand · sign-ups
  on instagram, x · budget $500 · owner you@brand.com
  2 approved · 1 rejected
    #5120  Approved           "Book in 30 seconds" — by you@brand.com, Nov 5, 3:04 PM
    #5121  Approved           "Three reasons" — by teammate@brand.com, Nov 5, 3:06 PM
    #5122  Rejected           "Big sale" — by you@brand.com, Nov 5, 3:07 PM · "Off-brand colours"
```

In `--json`, each creative carries `approval_state`, `approved_by`, `approved_at` and
`approval_note`; a review answer also says `"published": false`.

## Common errors

| You see | It means | Do this |
|---|---|---|
| `Campaigns aren't set up on board 912 yet` | setup has not run on this board | `iris campaigns setup --bloq 912` |
| `You can't manage campaigns on board 912` | you are a viewer, or not on the board | ask the board's owner to make you an editor of the whole board |
| `You don't have access to board 912` | not a member, or the board does not exist | check the id: `iris bloqs list` |
| `Say why it was rejected` | `reject` without `--reason` | add `--reason "…"` |
| `already has a campaign-creative dataset that its owner did not create` | someone else made a dataset with that name on your board | nothing was changed; contact support to remove it, then run setup again |

## Related recipes

- `atlas-datasets.md` — the datasets underneath (records, history, export work on them unchanged)
- `bloq-access-control.md` — who can see and change your board
- `page-privacy.md` — keeping the review page members-only
