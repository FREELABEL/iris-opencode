---
category: Pages & Design
level: intermediate
tags: [genesis, design, standards]
duration_min: 15
prerequisites: [pages]
---
# Genesis Design Standard — READ BEFORE BUILDING ANY PAGE

The house design standard for every Genesis `/p/` page, bespoke page and artifact.
**Not advisory.** Read it before writing a line of HTML or CSS.

**Full standard:** https://heyiris.io/p/design-philosophy-and-page-audit
Genesis page #325 · bloq item #178999 (bloq 571, list #1783) · `pages/design-philosophy-and-page-audit.json`

Written after the IRIS Labs page, so the reasoning behind a page people actually liked could be
scored and reapplied instead of re-derived each time.

## The 10-point audit — score BEFORE publishing

1 point each. **9–10 ship · 6–8 revise · 0–5 redesign.**

| # | Check |
|---|-------|
| 01 | **Subject-derived** — the design comes from this subject's world, not a template |
| 02 | Neutrals **chosen** — hue-biased toward the accent, never `#f5f5f5` / `#000` |
| 03 | Semantic colour (good/warn/critical) is **separate** from the accent |
| 04 | Three type roles — display / body / **data, with mono on all numbers** |
| 05 | Structure encodes something **true** — numbering only where order carries meaning |
| 06 | Figures **argue**, they don't decorate |
| 07 | Copy is clean of internal vocabulary |
| 08 | Both themes defined at **token** level |
| 09 | Motion **once**, with a reason |
| 10 | **Render verified in a browser** |

## Check 01 is the predictor

> Could this design be moved onto a different subject unchanged?

If yes, it is a template, it will score ≤4, and local fixes will not rescue it.
Restart from the subject.

## Non-negotiables — each learned by shipping something broken

**Theme comes from the HOST, not the OS.** Inside a Genesis page switch on `html.dark`.
Never `@media (prefers-color-scheme)` — a CustomHtml block that follows the OS renders dark
inside a light page, which is exactly what it looks like: broken.
*(Claude artifacts are the opposite — they own their document and do use `prefers-color-scheme`.)*

**A CustomHtml block must not paint its own `background`.** It becomes a slab floating on the
page ground. Inherit it.

**Namespace every selector.** `CustomHtml` injects through `v-html` with no isolation — a bare
`body`, `section` or `table` rule leaks into the host page and wrecks the theme.

**No webfont CDNs.** The CSP blocks them and it silently falls back to Arial. Build stacks from
faces that ship on macOS and Windows, or inline a data URI.

**Render-verify before calling it done.** Grepping strings out of the served HTML is not
verification — the page can contain every string you searched for and still look broken.
Point 10 exists because this failed in production.

## Two CSS traps, both found only by looking at the published page

- `grid-row: 1 / span 99` to make a marker span a block **creates 99 implicit rows** — with a row
  gap that adds ~110rem of dead space per section. Pin the marker to `grid-column:1; grid-row:1`
  and put everything else in column 2.
- A grid `li` mixing an inline `<b>` with a trailing text node drops that anonymous text into the
  next free cell (the narrow marker column) → one word per line. Use an absolutely-positioned
  marker plus padding for mixed inline content.

## Related

`iris how-to view bespoke` · `iris how-to view pages` · the `/bespoke` skill
