---
category: Pages & Design
level: intermediate
tags: [genesis, pages, html, customhtml, trusted owner, sandbox, 403, publish-html]
duration_min: 5
prerequisites: [pages, bespoke]
---
# "Restricted to trusted owners" — publishing custom HTML on a page

You pushed a page and got a 403:

```
Inline raw HTML (the CustomHtml component, page css on a composable page, or an embedded
component artifact) is restricted to trusted owners.
```

Nothing is broken, and you do not need anyone to change the page's owner. **Publish the HTML as a
standalone page instead.** Every account can do that.

## The fix

```bash
iris genesis publish-html <slug> --file page.html
```

`page.html` is an ordinary HTML file: your `<style>` and your markup. It becomes the whole page at
`heyiris.io/p/<slug>`. Use the same slug to replace an existing page.

## Why the push was refused

There are two ways to put your own HTML on a page, and they are trusted differently:

| Way | What it is | Who can publish it |
|---|---|---|
| **Standalone page** (`publish-html`) | Your HTML is the whole page | **Every account.** Untrusted accounts' pages are served in a browser sandbox |
| **Inline HTML** (a `CustomHtml` block, page `css` on a component page, an embedded artifact) | Your HTML runs *inside* the IRIS page | **Trusted accounts only** |

A standalone page is a whole document, so the browser can sandbox it. Inline HTML runs inside the
IRIS app itself, where there is nothing to sandbox, so it stays restricted no matter who owns the
page.

Trust belongs to the **account publishing**, not to the page's owner or its board. Moving a page to
a different board does not change this answer.

## What a sandboxed page can't do

A standalone page from an untrusted account runs at the same URL, but the browser treats it as
coming from nowhere. Plain HTML and CSS, and scripts that only work inside the page, are fine.
These are not:

- `localStorage`, `sessionStorage` and cookies — keep state inside the page instead.
- IRIS sign-in (OTP), transcription and onboarding calls from the page.
- Data bindings to private datasets — only **public** datasets bind.
- Preview sessions — publish, then check the live page.

When the page is saved, `publish-html` prints anything in your HTML that will not work sandboxed.

Check how a live page is served:

```bash
curl -sI https://heyiris.io/p/<slug> | grep -iE '^(x-genesis-sandboxed|content-security-policy):'
```

`x-genesis-sandboxed: 1` means it is sandboxed. That is correct for an untrusted account.

## When you really need an unsandboxed page

If a page needs any of the list above, the answer is trust for your account, not a workaround.
Ask the IRIS team to grant your workspace the `raw_html` capability. Trust lets the account run
code as any visitor, so it is granted per workspace by an operator, not as a plan feature.

## See also

- `iris how-to view bespoke` — designing and building the HTML itself
- `iris how-to view genesis-design-standard` — the audit to score a page before publishing
- `iris how-to view genesis-verify-pages` — checking the render in a real browser
