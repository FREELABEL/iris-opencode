---
category: Infrastructure
level: intermediate
tags: [hive, shortcuts, siri, tailscale, daemon, api]
duration_min: 20
---
# How to: Reach your Hive from your phone (Apple Shortcuts, Siri, or any HTTP client)

## What this does

Lets you check your Hive inbox, send a message to a peer node, or read daemon
status **from a phone**, with nothing installed on it. "Hey Siri, check my Hive."

It works because the daemon already speaks HTTP and Tailscale can put that HTTP
on your phone without opening anything to the internet. There is no new server
and no app.

## Read this part before you build anything

The daemon binds `127.0.0.1` by design. Everything below starts by **publishing
it to your tailnet**, and the moment you do, "reachable" stops meaning "me".

A tailnet is not a list of your own devices. Run `iris hive vpn status` and read
the list out loud. A typical one carries a client's machine, a contractor's
laptop, a phone you set up once. Every one of them can now open that port.

That is survivable because every route that returns anything of yours requires
`X-Bridge-Key`. It was not always so: until 2026-09-12 `/hive/inbox` returned
message **bodies** to anyone who asked, defended by a CORS allowlist — which
browsers honour and curl, scripts, native apps and other machines ignore
entirely (#184824). If you are running a daemon older than that, update before
you publish the port.

**Treat the bridge key as a password**, because it is one. It opens everything
in the table below. A Shortcut you share — via iCloud link, AirDrop, or a
screenshot — carries its contents with it, including any key you typed into it.

## Step 1 — get on the tailnet

```bash
iris hive vpn status          # installed? logged in? who else is here?
iris hive vpn up              # if not logged in
```

On the phone: install Tailscale, sign in to the same tailnet. It will appear in
`iris hive vpn status` on your Mac.

## Step 2 — publish the daemon port

```bash
iris hive vpn serve 3200
```

This needs **MagicDNS** and **HTTPS Certificates** enabled once in the Tailscale
admin console (DNS tab). Without them `tailscale serve` does not error, it
*hangs* — the command checks for this and tells you rather than timing out.

It prints an `https://<machine>.<tailnet>.ts.net` address. That address is
reachable **only** from devices on your tailnet. It is not on the public
internet. (`tailscale funnel` is the one that would do that. This is not that.)

Undo it with `iris hive vpn serve 3200 --off`, and check what a machine is
currently publishing with `iris hive vpn serve 3200 --status`.

## Step 3 — get the key onto the phone

```bash
cat ~/.iris/bridge-token
```

Put it somewhere the phone can reach: your password manager is the right answer.
Then paste it into the Shortcut as a header value.

## The API

Base URL is the `ts.net` address from step 2. **Every route below needs the
header** `X-Bridge-Key: <token>`.

| Method | Path | What it returns |
|---|---|---|
| GET | `/hive/inbox?limit=50` | `{ items: [...], unread: N }` — manifest of received messages |
| GET | `/hive/inbox/<id>` | one item including `body` |
| POST | `/hive/inbox/<id>/read` | marks it read |
| GET | `/daemon/queue` | active tasks, pause state, capacity gate |
| GET | `/daemon/sessions` | live agent sessions on this node |
| GET | `/daemon/processes` | what the node is running |

These need **no** key, and are safe to hit from anything — they carry no content
of yours: `/health`, `/daemon/health`, `/daemon/capacity`, `/daemon/profile`.

A `401` answers with `how_to_fix` and a `reason` of either `key_missing` or
`key_mismatch`, so a Shortcut that fails can tell you which of the two it is.

One trap worth knowing, because it cost time writing this page: auth runs
**before** routing, so an unauthenticated request to a path that does not exist
answers `401`, not `404`. `/daemon/status` looks like a protected endpoint from
the outside and is simply not a route. Probe with the key — a `404` with the key
means the route is not there, and no header will conjure it.

Check it from your Mac first — if this does not work, no Shortcut will:

```bash
curl -H "X-Bridge-Key: $(cat ~/.iris/bridge-token)" \
     https://<machine>.<tailnet>.ts.net/hive/inbox
```

## The easy way: the built-in page

Before building anything, open this on the phone:

```
https://<machine>.<tailnet>.ts.net/hive/ui
```

It is a page the daemon serves: unread count, the message list, tap to expand
the full body. It asks for the bridge key once and keeps it in that browser.
**Add to Home Screen** and it behaves like an app.

It is read-only — see "What this does NOT give you" below. Build a Shortcut when
you want Siri, or a one-tap answer without opening anything.

## Step 4 — build the Shortcut

**"Check my Hive"** — three actions:

1. **Get Contents of URL**
   - URL: `https://<machine>.<tailnet>.ts.net/hive/inbox?limit=5`
   - Method: GET
   - Headers: `X-Bridge-Key` = your token
2. **Get Dictionary Value** — key `unread`
3. **Speak Text** — `There are [unread] unread messages in your Hive.`

Name it "Check my Hive" and Siri uses the name as the phrase.

**"Read my latest Hive message"** — add, between 2 and 3:

- **Get Dictionary Value** — `items` → **Get Item from List** — First Item
- **Get Dictionary Value** — `message`
- **Speak Text** with that value

**Add to Home Screen** from the share sheet for a one-tap version.

## When it does not work

| Symptom | What it is |
|---|---|
| Shortcut hangs, no error | HTTPS Certificates not enabled for the tailnet — step 2 |
| `401 key_missing` | header name is wrong, or Shortcuts dropped it — retype `X-Bridge-Key` |
| `401 key_mismatch` | the token rotated. `cat ~/.iris/bridge-token` again |
| Connection refused | daemon is down (`iris hive status`), or `serve` was turned off |
| Works on wifi, not on cellular | phone dropped off the tailnet — open the Tailscale app |

## What this does NOT give you

**Sending** from the phone. `/hive/inbox` is read + mark-read only; there is no
`POST /hive/send` on the daemon. Sending goes through `iris hive send` on a
machine with the CLI. A phone-side send is tracked as #184810.

Do not work around that by publishing a shell-execution route to the tailnet.
The daemon has routes that run code, they require the same single key, and that
key is now sitting in a Shortcut on your phone.
