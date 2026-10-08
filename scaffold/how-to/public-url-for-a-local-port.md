---
category: Infrastructure
level: intermediate
tags: [hive, tunnel, public-url, share, localhost, https]
duration_min: 5
---
# How to: Give something on your machine a public URL

## What this does

Gives a site or app running on your machine (say `localhost:3000`) a public **https** address
anyone can open — to show a client a preview, test a webhook, or share a demo. The connection is
encrypted all the way to your machine.

## Prerequisites

- Tailscale is on (`iris hive vpn status`) — every Hive machine already has it
- Once, in the Tailscale admin console: enable **MagicDNS** and **HTTPS Certificates**, and allow
  **Funnel** for this machine (Access controls → node attribute `funnel`)

## Steps

**1. Open it — it lasts while the command runs**

```bash
iris hive tunnel 3000
```

You are asked to confirm, because the address is reachable by **anyone on the internet**. Then:

```
● https://your-machine.your-tailnet.ts.net:8443 → localhost:3000
  public for 1h or until Ctrl-C
```

Press **Ctrl-C** to close it. It also closes by itself after `--for` (default 1 hour).

**2. Choose how long**

```bash
iris hive tunnel 3000 --for 30m
```

**3. Keep it open after the command ends (only when you mean it)**

```bash
iris hive tunnel 3000 --bg
iris hive tunnel 3000 --off      # close it
```

## Safety built in

- It never opens the Hive bridge port (3200) — that one runs commands, so it is refused outright.
- It uses public port 8443 by default, so it never replaces a private (tailnet-only) share on 443.
- Nothing stays open by accident: foreground by default, a timer, and a confirmation.

## Common problems

**"HTTPS certificates are off for this tailnet"** — Tailscale admin → DNS → enable MagicDNS, then
HTTPS Certificates.

**"Funnel is not allowed for this machine"** — Tailscale admin → Access controls → add the `funnel`
node attribute for it.
