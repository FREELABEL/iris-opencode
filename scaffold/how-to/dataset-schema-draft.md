---
category: Data
level: beginner
tags: [atlas, datasets, schema, draft, ai, phi, visibility, create, dry-run]
duration_min: 3
---
# How to: Draft a dataset schema from a sentence

## What this does

Describe the data in plain words; IRIS proposes typed fields with a visibility for each —
`public`, `private` or `phi`. It **creates nothing**. You review it, then create it yourself.

## Steps

```bash
iris datasets schemas draft "patient intake with insurance"
```

Fields that look like patient data (date of birth, insurance, policy number…) are marked `phi`;
anything uncertain is `private`, never `public`.

**Check it, then create it**

```bash
iris datasets schemas draft "patient intake with insurance" --json \
  | iris datasets schemas create --name intake --fields - --dry-run    # checks, writes nothing

iris datasets schemas draft "patient intake with insurance" --json \
  | iris datasets schemas create --name intake --fields -              # creates it
```
