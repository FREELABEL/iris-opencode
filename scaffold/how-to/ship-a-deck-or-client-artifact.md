---
category: Content & Media
level: intermediate
tags: [deck, pdf, remotion, artifact, genesis, cdn, brand-tokens]
duration_min: 20
---

# Ship a deck, a document, or a client artifact

The whole pipeline: author → render → versioned PDF → CDN → shareable Genesis page.
Every gotcha below cost a real render to find. None of them raise an error.

---

## The three artifact shapes

| You want | Build it as | Ends up as |
|---|---|---|
| Slides for a meeting | HTML sections → `deck-cli.js` | 1920×1080 PNGs + a versioned PDF on the CDN |
| A document someone reads | Genesis page (`CustomHtml`) | `heyiris.io/p/{uuid}`, unlisted |
| Both | the same HTML, twice | deck for the room, page for the link |

---

## 1. Slides

### Author

One HTML file. `.hero` for the cover, one `<section>` per slide.

```html
<div class="hero"><div class="wrap"> … </div></div>
<section><div class="wrap"> … </div></section>
```

**The `.wrap` is mandatory.** `screenshotHTML()` forces `padding: 60px 0` on the isolated
section, which wipes any horizontal padding you set. Without an inner wrapper your content
runs off both edges. Put every inset on `.wrap`.

**One gutter for everything.** Absolutely-positioned chrome (page numbers, marks, logos)
must use the same left/right offsets as `.wrap`, or it drifts. And never set
`position:relative` on `.wrap` — it becomes the containing block and your footer floats
into the middle of the slide.

### Render and ship

```bash
node deck-cli.js html decks/<name>.html --name <name>   # sections → PNGs
node deck-cli.js render <name>                          # → carousel-<name>/
node deck-pdf.js <name> --bump --label "audience"       # → versioned PDF
iris cloud:upload "<pdf>" -t "Name · v3" -e never       # → CDN
```

`--bump` increments `version` in `decks/<name>.json`, so the filename carries it:
`Name-v3-2026-08-11.pdf`. A PDF in someone's downloads in three weeks is still identifiable.

### Deck JSON

Full-bleed figure slides are `{"type":"code","imageUrl":"<name>-slides/section-NN-….png"}`
with **no caption and no title** — that triggers full-bleed mode and drops all chrome.
Slide order lives in the JSON, so you can author sections in any order and sequence later.

---

## 2. Documents → Genesis

```bash
# write page JSON: {"version":"1.0","type":"landing","theme":{…},
#   "components":[{"type":"CustomHtml","id":"doc","props":{"html":"…"}}]}
iris pages:batch <dir> --publish
iris pages visibility <slug> unlisted     # → /p/{uuid}, slug goes dead
```

**Do not use `iris pages create`** — it scaffolds a `SiteFooter` with no `copyright` and
fails validation every time (#179689). `pages:batch` works.

**Never use `visibility private`** (#179716). It is a one-way door: the page cannot be read,
published, shared, reverted *or deleted*, and it holds its slug forever. Use `unlisted` —
the `/p/{uuid}` URL is unguessable and undiscoverable. If you need revocable access, mint a
share link *before* changing visibility.

---

## 3. Always verify the render

Green console output is not evidence. Open the image.

Found only by looking, none of which errored:

- a `div` does not preserve newlines — a terminal block collapsed to one line
- **a CSS class `fill` beats an SVG `fill` attribute** — 17 colours silently rendered grey.
  Use `style="fill:…"` inline
- a new prop added to the schema never reached the renderer, because `render-deck.js`
  builds its props list by hand
- labels sitting on top of their own connector lines
- text overrunning its box on four separate slides
- a missing `</text>` silently deleting everything after it

### The stale-render trap

**Renaming a heading changes the screenshot filename.** The deck JSON keeps pointing at the
old file, which still exists — so it renders a *previous version of the slide* with no error.
This shipped a deck missing a whole section that had been reported as done.

`deck-pdf.js` now refuses to build when the deck's slide count and the PNGs on disk disagree.
Check references explicitly after any heading change:

```bash
python3 -c "
import json,os
d=json.load(open('decks/<name>.json'))
live=set(os.listdir('public/<name>-slides'))
print([s['imageUrl'] for s in d['slides']
       if s.get('imageUrl') and s['imageUrl'].split('/')[-1] not in live] or 'clean')"
```

---

## 4. Verify the CDN too

A printed URL is not proof the bytes landed.

```bash
curl -sSI "<cdn-url>" | grep -iE "^HTTP|content-length"
ls -l "<local.pdf>" | awk '{print $5}'    # must match exactly
```

---

## 5. Use the client's real brand

```bash
iris brands list
iris brands dt get <slug>          # design tokens — the source of truth
```

The hardcoded values in `remotion/src/brands.ts` drift from the live design tokens, and they
drift in the way that costs you a rebuild: one brand's entry there is a dark theme while its
actual tokens are a light one — a different ground, not a different shade. Pull the tokens,
do not trust the file.

If rebuilding an existing client deck, mine the original for its own palette:

```bash
python3 -c "
import zipfile,re
z=zipfile.ZipFile('deck.pptx')
x=z.read([n for n in z.namelist() if 'theme1.xml' in n][0]).decode('utf8','ignore')
s=re.search(r'<a:clrScheme.*?</a:clrScheme>',x,re.S).group(0)
for m in re.finditer(r'<a:(\w+)>\s*<a:srgbClr val=\"(\w{6})\"',s): print(m.group(1),'#'+m.group(2))"
```

---

## 6. Read the source material first

- **.pptx / .docx are zips.** Extract `ppt/slides/slideN.xml` or `word/document.xml`,
  strip tags. Faster than asking for a re-export.
- **PDFs**: `qlmanage -t -s 1800 -o <dir> file.pdf` renders page 1. Do this. Metadata told me
  a deck had 335 icons and six accents; *looking* at it revealed a navy left rail, a two-tone
  title and a pill eyebrow — the things that actually defined it.
- **Google Drive currently cannot read Docs** (#179737) — the Composio connection lists and
  searches but cannot export. Ask for local PDFs or Markdown.

---

## 7. Design check before shipping

Run the ten-point audit (`/p/design-philosophy-and-page-audit`). Check 01 predicts the rest:
*could this design be moved onto a different subject unchanged?* If yes it is a template.

A deck built by reusing another page's visual system scored **4/10 — Redesign** — while
looking perfectly professional. Borrowed polish reads as generated.
