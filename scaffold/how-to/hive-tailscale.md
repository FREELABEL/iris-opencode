# How to: Reach a machine that isn't on your network (Hive + Tailscale)

## The one-paragraph version

Tailscale is the **road**. The Hive is the **work that travels on it**. They are not
alternatives and neither replaces the other — Tailscale gives a machine anywhere in the
world a stable private address without opening a single port to the internet, and the Hive
is what IRIS then does with that machine. `iris hive vpn` wraps the Tailscale parts so you
never have to leave the CLI.

## Two ways IRIS reaches a machine, and how to pick

This is the part people get wrong, because both are called "connecting a machine".

|  | **Daemon rail** | **Tailnet rail** |
|---|---|---|
| Who dials whom | the machine dials **out** to IRIS | you dial **in** to the machine |
| Needs Tailscale | no | yes |
| Needs open ports | no | no |
| Carries | `NodeTask` — sandboxed, audited agent work | anything: RDP, SSH, a GUI app, a database port |
| Identity | the node's API key | tailnet ACL (group → tag) |
| Set up with | `iris daemon start` | `iris hive vpn up` |
| Covered by | `iris how-to hive-dispatch` | this recipe |

**Use the daemon rail** when you want IRIS to *run something* on a machine — generate code,
execute a script, run a batch. The machine can be behind any NAT, any firewall, any coffee
shop wifi. It only ever makes outbound connections.

**Use the tailnet rail** when a *human or a session* needs to reach the machine itself —
remote desktop into a Windows box, hit a database that only listens on localhost, drive a
desktop application that has no API. QuickBooks Desktop is the canonical example: there is
no cloud API, so something has to actually be at the keyboard.

**Use both** when you want agent work running on a machine you can also sit down at. They
compose cleanly and do not conflict.

## The three layers

```
  Layer 3   IRIS Hive node        what IRIS may do there — enroll, run, audit
  Layer 2   Tailscale ACL         WHO is allowed to reach it, and on which port
  Layer 1   Tailscale (WireGuard) the encrypted road itself — no public ports
```

Every layer is a separate decision. Being on the tailnet does **not** grant access to a
machine; the ACL does. Being reachable does not make a machine a Hive node; enrolling does.
Keep them separate in your head and the failure modes stay obvious.

## Prerequisites

- IRIS CLI installed and authenticated
- A Tailscale account (the free tier covers small teams comfortably)
- Admin rights on the machine you want to reach, once, to install Tailscale

## Step 1: Preflight

```bash
$ iris hive vpn check
```

Tells you what's missing on **this** machine — Tailscale installed, logged in, and which
tailnet IP you hold. Run it first; it saves diagnosing a problem you don't have.

## Step 2: Install and join

On each machine you want on the mesh:

```bash
$ iris hive vpn install     # auto-detects the OS
$ iris hive vpn up          # prints a login URL the first time
```

`up` prints a URL. Open it, sign in, and the machine joins your tailnet and receives a
stable `100.x.y.z` address. That address does not change when the machine moves networks —
which is the entire point, and the reason this beats port-forwarding or a jump host.

On Windows, Tailscale installs outside `PATH`; `iris hive vpn` knows where to look, so the
commands work the same on a Windows Server box as on a Mac.

## Step 3: See the mesh

```bash
$ iris hive vpn status
```

Every machine on the tailnet: name, OS, tailnet IP, online or not. This is your inventory —
if a machine isn't here, nothing downstream will work, and you've found your problem in one
command.

## Step 4: Lock it down BEFORE you use it

Do not skip this. By default a tailnet is permissive: every device can reach every other
device. That is convenient for one person and wrong the moment a client's machine or a
contractor joins.

```bash
$ iris hive vpn grant <group> <node-tag>
```

Scaffolds a least-privilege ACL — one group, one tagged node, one port — and prints it for
you to paste into the Tailscale admin console. The shape it produces:

- a **group** (e.g. your accounting team) is the only source allowed
- a **tag** on the target machine is the only destination
- a **single port** (e.g. RDP 3389) is the only thing open

Anyone outside the group cannot see the machine at all. Not "denied" — invisible.

**Why the group and not a list of people:** a group is managed in one place, so removing
someone from the team removes their access everywhere at once. An ACL listing individuals
is a list you will forget to update, and access you forget about is access you still have.

## Step 5: Connect

```bash
$ iris hive vpn host <name>      # connection details: IP, RDP target, how to connect
$ iris hive vpn connect <name>   # launches the remote desktop session directly
```

`connect` is the one-command path — it resolves the name, finds the right client for your
OS, and opens the session.

## Step 6: Make it a Hive node (optional, and the point of doing all this)

A machine on the tailnet is reachable. Making it a **Hive node** is what lets IRIS dispatch
work to it:

```bash
$ iris hive vpn enroll <tailnet-ip>
$ iris hive nodes list
```

`enroll` wraps `hive enroll` over the encrypted tunnel, so the enrollment itself never
crosses the public internet. After that the machine appears in `iris hive nodes list` and
can receive tasks like any other node.

## Step 7: When something is wrong

```bash
$ iris hive vpn doctor
```

Checks the whole chain in order — installed, logged in, peers visible, target host
reachable — and tells you which link is broken. Work the layers from the bottom:

| Symptom | Layer | Check |
|---|---|---|
| `tailscale-not-installed` | 1 | `iris hive vpn install` |
| Machine missing from `status` | 1 | is it powered on and logged in? `iris hive vpn up` on that box |
| Visible in `status`, connection times out | 2 | ACL — the road exists, you're not allowed on it |
| Reachable but not in `nodes list` | 3 | not enrolled — `iris hive vpn enroll <ip>` |
| Enrolled but tasks never run | daemon | different rail — see `iris how-to hive-dispatch` |

That last row is the one that wastes the most time. **A node being reachable over Tailscale
does not mean its daemon is running.** They are independent: the tailnet rail can be
perfect while the daemon is stopped, and the daemon can be happily executing tasks on a
machine that is not on the tailnet at all.

## What this does NOT do

Worth stating plainly so you don't go looking:

- **It does not replace the Tailscale admin console.** Users, DNS, auth keys and the
  authoritative ACL file live there. `iris hive vpn grant` scaffolds the ACL; a human still
  reviews and applies it. That is deliberate — an ACL is a security boundary and should not
  be edited by a machine on your behalf.
- **It is not a substitute for the daemon rail.** If all you need is "run this task on that
  machine", you do not need Tailscale at all.
- **It does not audit what a human does in an RDP session.** Hive audits *Hive tasks*. Once
  you are sitting at a remote desktop, you are sitting at a desktop.

## The pattern worth stealing

The reason this combination is worth the setup is that it collapses a normally-expensive
problem — *give a specific group access to one specific application on one specific machine,
from anywhere, without exposing it to the internet* — into a handful of commands, with the
access rule written down as configuration rather than living in someone's memory.

The usual alternatives are a VPN concentrator, a jump host, or port-forwarding plus a
prayer. All three are more work to set up, more work to revoke, and harder to explain to an
auditor than "this group, this tag, this port."
