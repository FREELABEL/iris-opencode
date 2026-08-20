# How to: build a certification — course, chapters, study material, quiz

How to create a course people are examined on, what makes a chapter examinable, and how the
resulting certificate gates who gets paid. The hunter's side of this — sitting the quiz, and
what a held payout looks like — is [bounty-os-hunter-journey](bounty-os-hunter-journey.md).
Pricing paid tutorials on Discover is a different thing entirely, in
[learning-tutorials](learning-tutorials.md).

## Why this exists

A certification is the thing standing between "somebody says they can do the work" and paying
them for it. `opportunities.required_certification_course_id` names a course, and until the
worker holds its certificate their payout is **held** — not voided. So a course is not
documentation. It decides money, and a chapter that examines nobody is a chapter that pays
everybody.

## Prerequisites

- Authenticated (`iris-login` complete)
- You will become the course's **instructor**, and only you or an admin can change it
  afterwards. Ownership is stamped from your session, never from the request.

## The shape

```
Course ── Program (the course's name and enrollment live on the program)
  └── CourseChapter          one per module; carries `quiz_data`
        ├── description      ← counts as study material on its own
        └── chapter_content  ← video | article | audio | image | deck
Deck ── the whole course's slides, ONE artifact, ONE PDF
  └── DeckPage.chapter_id    ← which section each slide serves
```

Two things people get wrong here:

**A deck is the parent, not a chapter's child.** A designer makes one deck covering the whole
certification and it delivers as one PDF somebody sits down and reads. Chapters are *sections*
of it (`deck_pages.chapter_id`), so a chapter never owns a deck and keeps exactly one parent —
the course.

**A chapter needs no content row at all.** The live hunter certification has none: its chapter
`description` IS the reading material, on purpose. Putting four paragraphs of policy behind two
more models and a CMS was the wrong trade, and that remains true.

## Steps

### 1. Create the course

```bash
iris course create --title "Agentic Design Certification" \
  --description "How we make graphics, AI-augmented." \
  --certificate
```

`--certificate` is what makes it able to issue one. Without it a student can finish and receive
nothing. Add `--publish` when it should be visible; leave it off while you are still writing.

### 2. Add chapters

```bash
iris course chapters add <courseId> --title "Brand rules" \
  --description "Neutrals are hue-biased. Never pure black."
```

The description is the study material for a text chapter. **A chapter with no description and
no content cannot be examined on anything** — `iris course chapters add` warns when you create
one, and `iris course get` flags it afterwards.

### 3. Check what is actually examinable

```bash
iris course get <courseId>
```

Chapters with no quiz are flagged. That flag is the point of the command: a chapter that looks
finished and assesses nothing is how a certification quietly stops meaning anything, and it is
invisible unless something says so.

### 4. Attach slides, if the material is a deck

A deck belongs to the course and its pages carry `chapter_id`. What matters is
**`deck_pages.body_text`** — the text of each slide:

- it is what a screen reader reads
- it is what quiz questions are derived from
- **a slide heading with no body does not count.** A heading names a topic; it is not something
  anyone can be fairly questioned on.

`Deck::isReadyForQuiz()` is false while any page is missing text, and false for an empty deck —
"no pages are missing text" must not read as ready when there are no pages.

### 5. Gate a bounty on it

```bash
iris opportunities update <id> --json    # confirm the listing first
```

Set `required_certification_course_id` on the opportunity. From then on:

- **Applying** is refused for gig-style listings until the person is certified.
- **Reporting a bug is never refused.** Making it harder to report a live vulnerability in
  order to enforce training is a net security loss, and unenforceable — they would just email
  it. Bug bounties are held at payout instead.
- **Payout is held**, never voided. Certifying releases work already accepted.

## What refuses, and why

| Symptom | Cause |
|---|---|
| `403` on any course write | Not the instructor. Ownership is `instructor_user_id`, or admin. |
| `403` on a course you created long ago | It has no instructor recorded, so it **fails closed** — every course predating ownership is in this state, and an admin has to set it. |
| Chapter shows `⚠ no quiz` | `quiz_data` is empty. Nothing is assessed. |
| Deck not ready for quiz | A page has no `body_text`. Check `pagesMissingText()`. |
| Chapter examinable, tiny text | A slide had a heading and no body. Headings are excluded from study text. |
| Worker certified but still held | The gate reads the certificate at payout — check the course id on the listing matches the certificate's. |

## What this does NOT do yet

**Nothing generates quiz questions.** `quiz_data` is written by hand — see
`SeedBountyTraining::chapters()` for the shape. The input for generating them exists
(`$chapter->studyText()` returns the chapter's material whatever backs it: a deck section, an
article, or just the description), and the generator does not. Do not assume a course you create
through the CLI is examinable until you have written its questions.

**`programs` has no owner column**, so a course cannot be owned through its program however
natural that reads.
