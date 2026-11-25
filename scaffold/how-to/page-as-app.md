---
category: Pages & Design
level: beginner
tags: [genesis, pages, app, home-screen, install, pwa, iphone, android, windows, mac, self-host, serve]
duration_min: 6
---
# Put your page on a home screen as an app

Every published IRIS page can be saved to a phone or computer as an app. It gets its own name
and its own icon, and it opens full screen on that page, with no browser bar. No app store, and
nothing to set up: it already works on every public page.

You can also run a page **on your own computer** with one command, so it keeps working when IRIS
Cloud doesn't.

## Save a page as an app

Open the page, then:

| Device | How |
|---|---|
| **iPhone / iPad** (Safari) | Share → **Add to Home Screen** |
| **Android** (Chrome) | ⋮ menu → **Install app** (or **Add to Home screen**) |
| **Mac** (Chrome or Edge) | the install icon at the right of the address bar → **Install** |
| **Mac** (Safari) | File → **Add to Dock** |
| **Windows** (Edge) | ⋯ menu → Apps → **Install this site as an app** |
| **Windows** (Chrome) | the install icon at the right of the address bar → **Install** |

The app is named after the page, and its icon is drawn from the page's logo. A page with no logo
gets a tile with its first letter in its own colour, so two saved pages never look the same.

## Choose the name and icon

Add an `app` block to the page:

```bash
iris pages pull my-page
# edit pages/my-page.json — inside json_content:
#   "app": { "name": "Saddlepass Bookings", "short_name": "Saddlepass", "theme_color": "#0f766e" }
iris pages push my-page --publish
iris pages cache-clear my-page
```

| Setting | What it does |
|---|---|
| `name` | the full app name, shown when someone installs it |
| `short_name` | the label under the icon. Keep it to about 12 characters; a phone shortens anything longer |
| `icon` | an `https://` image to draw the icon from (PNG or JPG; a square one is used edge to edge) |
| `theme_color` | the tile colour when the icon is a letter |
| `installable` | `false` stops the page from being installed as its own app |

Pages behind a sign-in are never offered as their own app: their name and icon stay private
until someone has signed in.

## Run a page on your own computer

```bash
iris pages serve my-page
```

That copies the published page to this computer, serves it at `http://localhost:<port>/p/my-page`,
and opens it so you can install it. It **starts again by itself** when the computer restarts, and
if it ever stops it comes back within seconds.

```bash
iris pages serve my-page --public   # also at https://my-page.<your Hive address>/p/my-page
iris pages serve list               # what is running here, and whether it answers
iris pages serve my-page            # run it again to pick up the latest published version
iris pages serve stop my-page       # stop it and remove it from startup
```

`--public` gives the page an https address that stays the same every time, so it can be opened
— and added to a home screen — from a phone. Anyone with that address can open it.

### Good to know

- **It shows the page as published.** Editing the page in IRIS does not change the copy on your
  computer until you run `iris pages serve my-page` again.
- **Data the page loads live** (lists, counts, feeds) may be empty in the copy. Pages whose
  content is written into the page work fully.
- **A Chrome-family browser** (Chrome, Edge or Chromium) lets the copy include everything the page
  loads as it runs. Without one it still serves, and says what may be missing.
- **`--public` needs this computer to be on your Hive** (`iris hive connect`).
- Previewing **your own edits** before publishing is a different command: `iris pages dev my-page`.

## If something is off

| You see | Do this |
|---|---|
| The app opens in a browser with an address bar | Delete it from the home screen and add it again. Phones remember an install. |
| The old icon after a change | Run `iris pages cache-clear my-page`, then delete and re-add the app |
| "will NOT start after a restart" | This computer refused the startup entry. The page runs until you restart; run the command again after. |
| "No public address: … taken" | Pick another name: `iris pages serve my-page --public --name my-other-name` |
| "behind a sign-in" | Signed-in pages need IRIS Cloud to check who is visiting, so they can't be copied. Keep them on IRIS. |

See also: `iris how-to view edge-publish` (put a page on your own web server, with releases you can undo).
