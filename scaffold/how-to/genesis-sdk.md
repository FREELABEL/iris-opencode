# Genesis SDK — giving a hand-authored page data and behaviour

A bespoke `render_mode: html` page is beautiful and inert. The SDK is the spine:
one script tag, no keys, no build step.

```html
<script src="/js/iris-sdk-1.0.1.js"></script>
```

**Pin the version.** The unversioned `/js/iris-sdk.js` sits behind Cloudflare with
`max-age=14400`, so a change to it takes up to four hours to reach a browser — that is how
the 1.0.0 → 1.0.1 fix was found still serving the old body from a container demonstrably
running the new one. Immutable versioned filenames make the long cache correct instead of
harmful.

Live check + full surface: **https://heyiris.io/p/iris-sdk-check**

## Why it works at all

The platform CSP is `connect-src 'self'` — a page can only reach its own origin. That
sounds like a limit; it is actually the enabler. The visitor's `atlas_session` cookie is
**first-party** on that origin, so it rides along on its own, and every endpoint the SDK
calls is a same-origin iris-api route that is already gated server-side.

**So the page needs no credential, and must never be given one.**

That is also why `iris atlas:datasets api <slug>` is the wrong thing to reach for from a
browser: it hands you a cross-origin URL (blocked) *and* an operator bearer key (a leak).

## Why it is a FILE and not an inline snippet

`script-src` is `'self' 'unsafe-inline'`, shipped **report-only**, and
`config/security.php` states the intent to enforce it and strip `'unsafe-inline'` via
nonces first. Anything pasted inline stops running that day; `/js/` is covered by
`'self'` and survives. Do not inline the SDK, and prefer the SDK over inline handlers.

## The surface

```js
iris.onboarding.session(slug)      // resumes or starts; survives a reload
iris.onboarding.flow(slug)         // step definitions
iris.onboarding.magicLink(token)   // NO recipient — server uses the session's email
iris.onboarding.complete(token)
iris.session.whoami()              // record with role + scope, or null when signed out
iris.session.requestCode(email) / verifyCode(email, code)
iris.configure({ bloqId, pageSlug })
iris.fmt.num · money · date · years · escape
iris.request(method, path, body)   // refuses anything not same-origin
```

## Errors

Every rejection is an `IrisError` with `status`, a flattened `fields` map, `isGate` and
`isValidation`. fl-api reports validation in two different shapes (`errors` and
`validation_errors`); both are flattened here so a page only learns one.

```js
try { await s.submit(data) }
catch (e) {
  if (e.isValidation) Object.entries(e.fields).forEach(([k, m]) => mark(k, m))
  else if (e.isGate) showSignIn()
  else showRetry(e.message)
}
```

`whoami()` returns `null` when signed out rather than throwing — a public page with no
visitor is the normal case, not an error.

## What it deliberately does not do

- **No authorization decisions.** It asks; the server answers. A permission check written
  in page JavaScript is decoration over a server rule, and if the rule is missing the
  decoration is a hole.
- **No Atlas dataset reads — yet.** That needs a `bindings[]` block on the page resolved by
  `PageDatasetController`, so the bespoke lane inherits the existing authz model
  (owner from the page, scope from the gate, PHI default-deny). **Do not build a
  `/atlas/datasets/{slug}` proxy** — the component lane deliberately addresses data by
  *binding id*, never by dataset slug, so a visitor cannot pivot tenants by editing a URL.
  A slug proxy throws that property away. Tracked as SDK-2 in bloq 503.

## Related

`iris how-to view onboarding-flows` · `iris how-to view bespoke` ·
`iris how-to view genesis-design-standard`
