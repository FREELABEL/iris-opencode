---
category: Content & Media
level: intermediate
tags: [evals, writing, model-quality, judge, calibration, ai]
duration_min: 15
---
# Evaluate an AI writer (and calibrate the judge first)

How to tell whether a model's output is any good, without trusting your own
impression of it — and the failure that wastes a day if you skip it.

## The one rule

**Calibrate the scorer against hand-labelled examples before you trust a single
number it produces.** Take one output you know is good and one you know is bad.
If the scorer cannot separate them, the scorer is broken — not the models.

This is not theory. Building the newsroom evaluator, the scorer rated a strong
hand-written article and a weak generated one **identically, at 20/100**, three
times in a row, for three different reasons:

1. Entity detection excluded sentence-initial words, so an article opening
   "Beatport banned…" scored **zero** named entities.
2. The lede check stripped the first character before looking for a capitalised
   name, decapitating the subject of every lede worth rewarding.
3. The lowercase disqualifier searched a *lowercased* corpus for a *lowercase*
   word — which always matches, so it disqualified every entity in every text.

Bug 3 is the dangerous shape: it makes good and bad score the same, which reads
as "this metric does not discriminate" rather than "this metric is broken." A
model tournament run on it would have produced a confident ranking that meant
nothing.

## The two tiers

Cheapest first. Most failures never need a model call.

### Deterministic — microseconds, no LLM

- **Filler phrases.** Build the list from your OWN bad output, not a style guide.
  Ours: "navigate the landscape", "ever-evolving", "as we dive deeper",
  "in conclusion", "it's important to note", "stay informed".
- **Numbers present.** 400 words with no digit is nearly always a description of
  a topic rather than a report of an event.
- **Named entities.** Capitalised tokens minus a sentence-starter stoplist. A
  real proper noun is never written lowercase elsewhere in the same piece — use
  the text to disqualify its own false positives, and search the ORIGINAL casing.
- **Lede describes an event.** First sentence contains a named entity and a past
  tense reporting verb (banned, announced, filed, left, found…).
- **Length** in the intended band.

These five alone caught every failure in the first three generated articles.

### Groundedness — the LLM tier

The RAGAS / FActScore pattern:

1. Decompose the output into discrete factual claims — anything checkable: a
   number, a name, an event, a rule, a date, an attribution. Skip opinion.
2. Judge each claim **in isolation** against the source material only. A claim
   that is plausible, or true in the world, but absent from the source is
   UNSUPPORTED.
3. Score = supported / total.

**Binary per claim, never a graded 1–5.** Judges are reliable at "is this
supported, yes or no" and unreliable at inventing their own scale steps.

Threshold at ~0.9 rather than 1.0: decomposers occasionally split one sourced
claim into two and mark the fragment unsupported. Calibrate the threshold on
hand-labelled examples before using it as a gate.

## Prose quality and truth are independent axes

Measure them separately. A brief we wrote by hand scored well on every prose
check and was largely fabricated. The layout being good is exactly what made it
dangerous. A model has to win both axes.

## Running a model tournament

`iris run -m provider/model "prompt"` is the harness.

**Probe availability first.** `iris models` lists more than the endpoint actually
serves — most zen models return "Model X is not supported". Ranking models you
cannot call wastes the whole run.

**`iris run` drains stdin.** A `while read -r m; do iris run …; done < models.txt`
loop tests exactly ONE model and then exits, because the command eats the list
feeding the loop. Redirect: `iris run … </dev/null`.

## Where this lives

- `fl-api` `app/Services/Newsroom/ArticleEvaluator.php` — both tiers
- `ai_evaluation_runs` table — records `git_commit` per run, so a score change
  correlates to a code change
- Playbook: `daily-brief`
