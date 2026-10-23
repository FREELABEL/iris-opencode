---
category: Infrastructure
level: intermediate
tags: [hive, tunnel, public-url, share, localhost, https, webhook]
duration_min: 5
---
# How to: Give something on your machine a public URL

## What this does

Gives a site or app running on your machine (say `localhost:3000`) a public **https** address
like `https://my-demo.t.heyiris.io` that anyone can open — to show a client a preview, test a
webhook, or share a demo.

It is encrypted all the way to **your** machine. The connection passes through the IRIS relay,
but the relay only reads the address on the envelope; it never has the key, so it cannot read
the traffic or pretend to be you. Your machine opens no ports and you change nothing on your
router.

## Prerequisites

- Signed in: `iris auth login`
- The Hive bridge on this machine: `iris bridge install` (also how you update it)

## Steps

**1. Open it — it lasts while the command runs**

```bash
iris hive tunnel 3000
```

You are asked to confirm, because the address is reachable by **anyone on the internet**. The
first time you use a name, getting its certificate takes about 30 seconds. Then:

```
● https://your-machine-3000.t.heyiris.io → localhost:3000
  public for 1h or until Ctrl-C
```

Press **Ctrl-C** to close it. It also closes by itself after `--for` (default 1 hour, max 24 h).

**2. Pick a name people can remember**

```bash
iris hive tunnel 3000 --name acme-preview
```

→ `https://acme-preview.t.heyiris.io`. The name is yours until you release it: nobody else can
use it, and next time it opens straight away with the certificate it already has.

**3. Keep it open after the command ends (only when you mean it)**

```bash
iris hive tunnel 3000 --name acme-preview --bg
iris hive tunnel --off --name acme-preview      # close it
```

**4. See and give back your names**

```bash
iris hive tunnel --list
iris hive tunnel --release acme-preview          # frees the name; deletes its key on this machine
```

## Safety built in

- It never opens the Hive bridge port (3200) — that one runs commands, so it is refused outright.
- Nothing stays open by accident: foreground by default, a timer, and a confirmation.
- Your certificate and its private key are made on, and stay on, your machine
  (`~/.iris/tunnels/<name>/`). The relay never has them.
- Names like `login`, `www`, `api` or `support` are reserved so a tunnel cannot pose as IRIS.

## Common problems

**"This machine's Hive bridge predates Hive tunnels"** — update it: `iris bridge install`.

**"The name … is taken"** — someone else holds it. Pick another with `--name`.

**"certificate: … retrying in 2 min"** — Let's Encrypt was busy or could not reach the tunnel yet.
It keeps trying on its own; the URL starts working when the certificate arrives.

**Prefer another provider?** `--provider tailscale` publishes through your tailnet (needs MagicDNS,
HTTPS Certificates and the `funnel` node attribute); `--provider ngrok` or `--provider cloudflared`
use those services if installed. `iris tunnel 3000` is the same command.
