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

A page behind a sign-in installs as its own app **for the people who can open it**. Anyone else
gets nothing: its name and icon stay private until someone has signed in.

## Put it in the Start menu, Dock or launcher from the terminal

```bash
iris pages install my-page            # Windows Start menu · Mac ~/Applications · Linux launcher
iris pages install my-page --remove
```

It opens in its own window with the page's icon, drawn at every size Windows needs.

## Run a page on your own computer

```bash
iris pages serve my-page
```

That serves the page from this computer at `http://localhost:<port>/p/my-page`, and opens it so
you can install it. It is **live**: signed in as you, it shows your data, its buttons work, and a
change you publish shows on the next load. It **starts again by itself** when the computer restarts, and
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

- **Live by default.** The copy on your computer fetches the page and your data from IRIS on every
  load, and with no network it opens with the last data it had. `--no-live` gives a frozen copy.
- **A `--public` copy is always frozen**, so your data is never put on the internet.
- Building an app around your own data — with buttons, and things only your computer can do?
  See **build-your-own-app**.
