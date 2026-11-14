---
category: Pages & Design
level: advanced
tags: [genesis, templates, brand, design-tokens, pages]
duration_min: 25
prerequisites: [genesis-starter-templates, genesis-design-standard, genesis-verify-pages]
---
# How to: Turn one of your Genesis pages into a template any brand can wear

## What this does

Makes a hand-written Genesis page cloneable: anyone can run
`iris genesis template use <yours> --brand <theirs>` and get your layout in their colour,
fonts and corners, still readable in light and dark, with your list of questions telling
them what to rewrite.

The trick is one rule: **everything that is the brand lives in one small block, and nothing
outside that block names a brand value.** Cloning replaces the block and nothing else.

## Prerequisites

- A standalone Genesis page (`render_mode: html`) that already scores 9–10 on the design
  standard: `iris how-to view genesis-design-standard`
- Its source HTML on disk, e.g. `pages/_src/my-page.html`

## Steps

### 1. See what a brand will bring

```
$ iris brands design-tokens export <some-brand> --format css --prefix brand
```

That prints exactly the block a clone receives. Use two real brands while you work — one with
a dark colour, one with a red or orange one. Those are the two that break templates.

### 2. Put the page's own identity in the block

At the top of your `<style>`:

```css
/* brand-tokens:start */
:root {
  --brand-accent: #21409a;
  --brand-font-display: "Franklin Gothic Medium", Arial, sans-serif;
  --brand-font-body: "Segoe UI", system-ui, sans-serif;
  --brand-radius: 6px;
}
/* brand-tokens:end */
```

The markers must be spelled exactly like that; the clone looks for them.

### 3. Point the rest of the page at the block, keeping a fallback

```css
.my-page {
  --accent: var(--brand-accent, #21409a);
  --display: var(--brand-font-display, "Franklin Gothic Medium", Arial, sans-serif);
  --r: var(--brand-radius, 6px);
}
```

Always keep the old value as the fallback. A brand that defines no radius should keep yours,
not get none.

### 4. Derive each theme's accent from the brand colour

A navy brand is invisible on a dark background. Don't use the brand colour raw; mix it per theme:

```css
.my-page { --accent: color-mix(in oklab, var(--brand-accent, #21409a) 90%, black); }
html.dark .my-page { --accent: color-mix(in oklab, var(--brand-accent, #21409a) 52%, white); }
```

### 5. Keep status colours away from the accent

"Done", "warning" and "error" get their own colours, never `--accent`. Otherwise a red brand
makes every button look like an error.

### 6. Check nothing is left hard-coded

```
$ grep -nE "#[0-9a-fA-F]{6}" pages/_src/my-page.html | grep -v -- "--"
```

Every hit outside a custom-property definition is a colour the clone cannot change — chart
colours are the usual ones.

### 7. Write the questions

List what someone has to answer to make the page theirs, one per line, in plain words: "What
do your common jobs cost, lowest and highest?", not "Edit the services dataset." Finish with
which bindings to point at their own datasets. These become the brief `template use` prints.

### 8. Look at it three ways before publishing

Open it as itself, and as two real brands, each in light and in dark. Six looks. Then:

```
$ iris genesis publish-html genesis-template-my-page --file pages/_src/my-page.html
$ iris pages verify genesis-template-my-page --expect "a phrase from the page"
```

### 9. Get it listed

The gallery at genesis-ui.com is curated. Send us the page and your questions and we'll
review it against the design standard and add it:

```
$ iris bug report "Template submission: my-page" -d "heyiris.io/p/genesis-template-my-page — questions: …" -s low
```

## Expected output

A clone of your page in a brand with a red accent and rounded corners shows your layout,
in red, with rounded corners, in both themes — and its "done" ticks are still green.

## Common problems

| Problem | Why | Fix |
|---|---|---|
| The clone keeps your colour | The colour is written directly somewhere, not through `var(--brand-accent, …)` | Step 6 |
| The accent disappears in dark mode | The brand colour is used raw | Step 4 |
| A clone loses its corners | No fallback in `var(--brand-radius)` | Always `var(--brand-radius, <yours>)` |
| The clone follows the visitor's OS into dark mode on a page meant to be light | The page uses `prefers-color-scheme` | Switch themes on `html.dark` / `data-theme`, chosen on purpose |

## Related recipes

- `genesis-starter-templates` — clone a template in your brand
- `genesis-design-standard` — the 10-point audit a template must pass
- `genesis-verify-pages` — prove it renders
