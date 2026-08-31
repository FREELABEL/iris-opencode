---
category: Data & Atlas
level: intermediate
tags: [ocr, vision, images, ingestion, invoices, scans, multimodal, cross-reference]
duration_min: 10
prerequisites: [data-sources]
---
# Reading scanned documents — OCR and vision ingestion

Most document ingestion is text: a PDF with a text layer, a CSV, a DOCX. **A scan is not that.**
A photographed invoice, a signed delivery note, a screenshot of a portal — those are pixels, and
they go through a vision model instead of a text extractor.

That path exists, it works, and until 2026-08-30 there was **no way to switch it on from the CLI**
and no page that said it existed.

## It is OFF by default, and it used to say nothing

Images are stripped from the file list unless you ask for them:

```bash
iris data-sources sync <bloq> google_drive <folder-id>                    # images SKIPPED
iris data-sources sync <bloq> google_drive <folder-id> --include-images   # images READ
```

Without the flag the job now records how many it dropped:

```
1 image file(s) skipped — re-run with --include-images to read them with vision/OCR.
```

Before that message existed, `20 files · 20 ingested` and `28 files, 8 of them scans, discarded`
looked identical. If a folder of invoices ingests and the scanned ones are missing, this is why.

## Cost control

```bash
--image-detail high   # default — reads small print, more tokens
--image-detail low    # cheaper and coarser; fine for layout, bad for figures
--image-detail auto
```

Every image is a vision API call. A folder of 200 scans is 200 calls, so start with a subfolder.

## Which model actually reads it

The chain, in order, with the first that answers winning:

```
  OpenAI  gpt-4o-mini      ──▶  OpenRouter  openai/gpt-4o-mini  ──▶  xAI  grok-4.3
  (default)                     (same model, different route)        (different model)
```

The fallbacks fire on quota/billing errors, not on a bad image. OpenRouter is second because it
serves the *same* model by another route, so the answer is unchanged; xAI is third because a
different model is a different answer.

**Read the model back — do not assume which one ran.** The extraction metadata records it:

```bash
iris atlas items <bloq> --search "<file>" --fields content --json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
      print(json.loads(d['items'][0]['content'])['extraction_info'])"

# {"model": "grok-4.3", "detail_level": "high", "confidence": 0.98, ...}
```

## What it returns

Two sections, both in the item's `text`:

```
=== EXTRACTED TEXT ===
INVOICE
Invoice No: HC-8812
...
=== IMAGE DESCRIPTION ===
A scanned invoice on white paper... a red rectangular border highlights
'PAID BY WIRE - REF 99417' at the bottom left.
```

The description is not decoration. Stamps, handwriting, signatures and strike-throughs appear
there and nowhere else — a red PAID stamp is the difference between an unpaid invoice and a
duplicate payment, and no text extractor will ever see it.

## Verified

A 1000×1300 PNG invoice, rotated 0.7° with per-pixel noise added, ingested with
`--include-images --image-detail high`:

| | |
|---|---|
| model | `grok-4.3` (OpenAI was out of credit, fallback fired) |
| confidence | 0.98 |
| read correctly | invoice no, date, PO ref, all 3 line items, subtotal, tax, total |
| also caught | the red `PAID BY WIRE — REF 99417` stamp, in the description |

Those values then cross-referenced against a purchase order: 4 matched, 2 did not, exit 1. **A
single misread digit would have failed a money assertion on the wrong value**, so a clean
comparison is also evidence about the transcription.

## Failure modes

| What you see | What it means |
|---|---|
| `N image file(s) skipped` | the flag is off — add `--include-images` |
| `credit_balance_exhausted` | that provider is out of credit; the chain should carry it — if it did not, no other key is set |
| `Vision failed on both providers` | both refused; the message names each and its reason |
| `Model not found: <x>` | `XAI_VISION_MODEL` points at a model the account does not have. There is no `*-vision-*` model on xAI — grok-4.x is natively multimodal |
| `invalid_image ... at least 8 pixels` | the image is too small for the provider |
| job stuck at `processing` | not OCR — the extraction model's provider is unreachable and the job has no timeout |

## Cross-referencing scans

OCR on its own gives you text. The point is comparing it to something:

```bash
iris playbook run document-crossref \
  source=google_drive path=<folder-id> bloq=<bloq> \
  schema=<dataset-slug> reference=./po-register.json \
  key=po_reference assert=total=approved_total \
  images=yes
```

Scan → vision OCR → typed record → joined to a reference → every discrepancy reported, non-zero
exit when they disagree. Which is the whole reason to read a scan at all.

## Benchmarking models on your own documents

Model choice is not a matter of opinion — run it:

```bash
iris playbook run ocr-benchmark path=<folder-id> bloq=<bloq> \
  models=gpt-4o-mini,gpt-4.1-nano,grok-4.3 \
  expect=./ground-truth.json
```

It reads the same images with each model and scores them field by field against ground truth you
supply, with latency. Accuracy on YOUR documents beats a leaderboard on someone else's.
