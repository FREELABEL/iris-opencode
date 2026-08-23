---
category: Pages & Design
level: intermediate
tags: [genesis, pages, verify, testing, render]
duration_min: 8
prerequisites: [pages]
---
# Verifying a Genesis page — read, verify, and why not curl

**Never verify a published page with `curl | grep`.** It returns false negatives in both
directions and cannot tell "broken" from "not measured".

## The two commands

```bash
iris pages read <slug>                      # rendered TEXT to stdout, diagnostics to stderr
iris pages read <slug> --json               # {url, lane, status, title, headings, words, bytes, text}
iris pages read <slug> --headings           # just h1/h2/h3

iris pages verify <slug> \
  --expect "a phrase from the page" \
  --expect "a figure that should be there" \
  --not-expect "Send code" \
  --min-words 400 \
  --lane bespoke                            # exits non-zero on any miss
```

`verify` is `read` plus assertions plus an exit code, so it composes into a script, a
deploy gate, or an agent loop. `read` is the primitive — pipe it wherever you like.

## Why grep on the served bytes cannot work

Measured on `/p/harness-position-paper`, a page that had published perfectly:

| check | said | truth |
|---|---|---|
| `grep -c 'THE HARNESS'` | 0 | headline is `text-transform:uppercase`; the bytes say `The harness` |
| a `data-page` regex | `AttributeError` | the ANSWER — no `data-page` means the bespoke blade served it — raised as a crash |
| `grep -c 'already shipping'` | 0 | phrase reworded; a count cannot tell "absent" from "different" |
| `wc -c` | 21294 | no threshold separates a bespoke doc from an Inertia shell |

Four checks, zero information.

## The trap underneath it

`innerText` applies `text-transform`; `textContent` does not. So the rendered layer says
`THE HARNESS` while the source says `The harness`, and they disagree in **both**
directions depending on which one you happen to remember. `verify` folds case and
typography unconditionally, so `--expect "THE HARNESS"` and `--expect "The harness"` both
pass. This is why you cannot fix grep by "just being careful with the case".

## Piping

Diagnostics go to **stderr** and content to **stdout**, deliberately:

```bash
iris pages read <slug> | grep -i "the harness"     # works — and an error still shows
```

If the read failed, the lane/status line survives the pipe. A filtered check that hides
its own error is the original sin here — do not rebuild it.

## What it does NOT tell you

`verify` proves the page *says* what you meant. It does not prove it *looks* right.
For layout, spacing and the 10-point design audit:

```bash
iris pages screenshot <slug>
iris how-to view genesis-design-standard
```

Note screenshots of a backgrounded window can show black bands mid-paint — those are
capture artifacts, not layout bugs. Measure the DOM before believing one.

## Drafts

`/p/` serves PUBLISHED pages only. Both commands refuse the not-found page and exit 1
rather than returning its text as if it were yours — so a draft fails loudly instead of
returning a confident empty answer.

## Related

- `iris how-to view bespoke` — shipping a hand-designed HTML page (`pages publish-html`)
- `iris how-to view genesis-design-standard` — the 10-point audit
- `iris how-to view pages` — the composable page CLI
