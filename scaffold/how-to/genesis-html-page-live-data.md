---
category: Pages & Design
level: intermediate
tags: [genesis, pages, html, atlas, datasets, bindings]
duration_min: 10
prerequisites: [bespoke, genesis-sdk]
---
# Live Atlas data on a standalone HTML page

A standalone HTML page (`render_mode: html`, published with `iris genesis publish-html`) can
show live rows from an Atlas dataset. You don't need a script that regenerates the HTML
every time the data changes. The page names its datasets once, in
`json_content.bindings`. The server reads the rows on every render and puts them into the
page before your script runs.

Use this for any page that lists records: events, packages, a roster, a price list. If a
visitor never needs to see the change until you republish, a static page is still fine.

## 1. Make the dataset public

A visitor who hasn't signed in only receives rows from a **public** dataset. For a
sandboxed page, that means every visitor (see below). "Public" takes two settings on the
schema:

- `settings.public: true`. Without it the binding is skipped and the page gets nothing.
- `"visibility": "public"` on every field the page shows. Fields marked `private` or `phi`
  are removed from each row on a public read. **New fields default to `private`**, so a
  schema created recently shows ids and nothing else until you mark its fields public.

Settings are **replaced as a whole**, so start from what is already there:

```bash
iris atlas:datasets schemas show <dataset-slug> --json      # copy the current fields + settings
# edit: add "public": true to settings, "visibility": "public" to each field you display
iris atlas:datasets schemas update <dataset-slug> --fields ./fields.json --settings ./settings.json
```

Each update creates a new schema version. The command reports how many records it carried
over. That number should match your record count.

The dataset has to belong to the account that owns the page's bloq. A page is bound to its
owner's data. It can't read another account's dataset, and a page that isn't owned by a
bloq gets no bindings at all.

## 2. Read the rows in the page

Put your script in `<body>`. `publish-html` keeps the body and the `<style>` blocks, and
drops everything else in `<head>`. The SDK (`/js/iris-sdk-1.0.4.js`) is added for you.

```html
<ul id="events"></ul>
<script>
  if (!iris.data.has('events')) {
    // The binding wasn't resolved: the dataset isn't public (or doesn't exist).
    // That is a refusal, not an empty list. Don't render "no events".
  } else {
    var rows = iris.data.rows('events');   // synchronous, already on the page
    document.getElementById('events').innerHTML = rows.map(function (r) {
      return '<li>' + r.title + '</li>';    // each row is { id, ...your fields }
    }).join('');
  }
</script>
```

`iris.data.meta('events')` returns `total_count`, `page` and `has_more`. Search and filter
`rows()` in the page's own script.

## 3. Publish, then declare the binding

```bash
iris genesis publish-html <page-slug> --file ./events.html --owner-id <your-bloq-id>
iris genesis set <page-slug> bindings.events <dataset-slug>
iris genesis cache-clear <page-slug>
```

Pass your own bloq with `--owner-id` on the first publish: its default is `38`, which isn't your bloq, so your
dataset wouldn't resolve. `bindings` maps the name your script uses (`events`) to the dataset slug. The page can only
read the datasets it names here. A script can't ask for a different slug at runtime.

**`publish-html` rewrites the whole page document and does not carry `bindings`.** Run the
`set` line again after every `publish-html`. Otherwise the next publish silently unbinds the
page and `iris.data.has('events')` goes `false`.

## What a sandboxed page gets

If your account isn't trusted for raw HTML, the page is served in a browser sandbox. The
heads-up that `publish-html` prints under the URL tells you when this applies. On a
sandboxed page:

- **Public datasets only**, even for a visitor who signed in through a gate.
- **The first 200 rows only.** The server reads one page of up to 200 rows into the page.
- **`iris.data.fetch()` doesn't work.** A sandboxed page's requests go out with
  `Origin: null`, which the API doesn't allow, so the browser blocks the response. Use
  `rows()`, which needs no request. If you need more than 200 rows, or private data, have
  your workspace trusted.

On a trusted account's page, `iris.data.fetch('events', { page: 2 })` (also `perPage`,
`search`) fetches further pages, and a gated page receives the signed-in viewer's rows.

Rows are read on each render. When you edit a record, the page shows the change on its next
load with no republish.

## Verify it on the live page

```bash
curl -sI https://heyiris.io/p/<page-slug> | grep -iE '^(x-genesis-sandboxed|content-security-policy):'
iris genesis verify <page-slug> --expect "<a title from one of your records>"
```

`verify` renders the page in a browser. Pass it text that only comes from the dataset, not
from your HTML. In a browser console on the page, `iris.data.names()` lists the resolved
bindings. An empty list with the binding declared means the dataset isn't public or isn't
owned by the page's bloq owner.

## Related

`iris how-to view bespoke` · `iris how-to view genesis-sdk` ·
`iris how-to view page-refused-trusted-owner`
