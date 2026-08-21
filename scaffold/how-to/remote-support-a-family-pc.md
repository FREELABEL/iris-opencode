# How to: Remotely support a family member's Windows PC

## The one-paragraph version

Put their machine on a **personal** tailnet, connect to it over that, and you can help them
without them having to do anything except turn the computer on. The whole job is three
decisions — which tailnet, which remote-control tool, and who is at the keyboard for the
first five minutes — and getting those wrong is what turns a 20-minute setup into a
recurring phone call. This recipe is the personal-scale sibling of
`iris how-to hive-tailscale`, which covers the same transport for client machines.

## Decision 1 — a SEPARATE tailnet, not the one your clients are on

Do not add a family PC to a tailnet that carries client infrastructure. If a client server
lives on it, that tailnet has an access-control story attached to it, possibly a compliance
one, and a home PC does not belong inside that boundary in either direction.

|  | **Client tailnet** | **Personal tailnet** |
|---|---|---|
| Signed in as | your work identity | a personal account |
| Plan | Standard or above — commercial use | **Personal, free** — 3 users, 100 devices |
| Holds | client servers, teammates | your machines, family machines |

The free Personal plan is genuinely free and genuinely allowed here — helping a parent with
their computer is exactly the non-commercial use it exists for. The moment a tailnet touches
billed client work it has to move to a paid plan; a family tailnet does not.

Worth checking which one **your own laptop** is on. It is easy to end up with your personal
machines sitting on a client tailnet because that is the one you set up first.

## Decision 2 — check the Windows edition FIRST

This is the step people skip, and it is the one that decides everything after it.

**Remote Desktop can only HOST on Windows Pro, Enterprise, or Education. Windows Home can
connect out, but nothing can connect in.** Most consumer laptops and prebuilt desktops ship
Home. Check before you plan anything else:

    Settings -> System -> About -> Windows specification -> Edition

| Their edition | Your options |
|---|---|
| **Pro / Enterprise / Education** | RDP over the tailnet. Cleanest. Proceed as written below. |
| **Home** | Either upgrade to Pro (in-place, no reinstall, keeps all their files), or use a screen-sharing tool that does not need RDP — RustDesk over the tailnet is the usual pick. |

For a parent, screen-sharing is often the *better* choice even when RDP is available. RDP
gives you a private session they cannot see; RustDesk or VNC shows them their own screen
with the pointer moving. When the request is "help me with this thing I am looking at,"
watching you fix it is most of the value, and it is far less alarming than the screen going
dark and logging them out.

## Decision 3 — someone has to be at the keyboard once

The tool that lets you help remotely cannot install itself remotely. This is the same
bootstrap constraint as `iris hive connect` on a headless host: the daemon is the thing that
lets you run commands, so it cannot be the thing that installs the daemon.

**Use Quick Assist for the first session.** It ships with Windows, needs no install, no
account, and nothing configured:

1. They press `Ctrl` + `Windows` + `Q`, or open Start and type "Quick Assist".
2. You open Quick Assist, click **Assist another person**, and read them the 6-digit code.
3. They type the code and click Share. You now have their screen.

Then **you** do the entire setup from inside that session. They never follow instructions
over the phone, never type a command, never read a password back to you. This matters more
than it sounds: talking a non-technical person through a Windows menu is where remote support
goes wrong, and the menus contain destructive options sitting next to the one you want.

## The setup, once you are on their screen

    # 1. Install Tailscale on their machine
    #    https://tailscale.com/download/windows

    # 2. Sign in with a personal account — invite them to your personal tailnet first,
    #    or sign in as yourself if the machine is genuinely yours to administer.

    # 3. Make it survive reboots without anyone logging in
    tailscale up --unattended

    # 4. If using RDP: enable it
    #    Settings -> System -> Remote Desktop -> On
    #    (absent on Home — see Decision 2)

    # 5. Note the tailnet IP
    tailscale ip -4

From your own machine:

    iris hive vpn status                  # confirm their node appears and is online
    iris hive vpn host <their-machine>    # connection details, RDP address, how to connect
    iris hive vpn connect <their-machine> # launch the session

## The two settings that stop it breaking in six months

Both matter far more for a parent than for a client machine, because when it silently stops
working they cannot diagnose it and you are not in the room.

**1. `tailscale up --unattended`.** Without it, Tailscale only connects after someone logs
into Windows. A machine that reboots overnight — after an update, after a power cut — sits at
the login screen unreachable, and the person who could log in is the person who needs your
help.

**2. Disable key expiry for their device**, in the Tailscale admin console under Machines ->
the device -> Disable key expiry. Node keys expire by default (around 180 days). When one
lapses, the machine drops off the tailnet and **nothing looks broken from their end** — no
error, no prompt, the Tailscale service still reports as Running. It just stops being
reachable, months later, with no connection to anything that changed.

That second one is not hypothetical. The same failure took down a production client host:
the service showed `Running` and `Automatic` the entire time while `tailscale status` said
`Logged out`. **A running Tailscale service tells you nothing about whether the node is
logged in.** Always check `tailscale status` for `Logged out` before diagnosing anything else.

## When it stops working

Check in this order — cheapest and most likely first:

    tailscale status                      # on their machine: "Logged out"? key expired.
    iris hive vpn status                  # from yours: does their node appear at all?
    iris hive vpn doctor                  # install, login, peers, host reachability
    tailscale ping <their-machine>        # a pong proves a real tunnel, not just control plane

If the node is missing entirely, it is almost always key expiry or a machine that rebooted
without `--unattended`. If the node is online but the remote session fails, it is the remote
tool, not the network — check the Windows edition question again, and check that Remote
Desktop did not get switched off by an update.

## What NOT to do

- **Do not open Remote Desktop to the internet by forwarding port 3389 on their router.** This
  is the advice you will find on forums and it is how home machines get ransomwared. The
  entire point of the tailnet is that no port is ever exposed.
- **Do not put them on a client tailnet** to save the setup time. See Decision 1.
- **Do not share an administrator account with them.** If you both use the same Windows login
  you cannot tell your changes from theirs, and a support session that goes wrong has no
  history to read back.

## Related

- `iris how-to hive-tailscale` — the same transport for client and production machines,
  including ACLs, tags, and `iris hive vpn serve`
- `iris how-to hive-dispatch` — the daemon rail, for running agent work on a machine rather
  than sitting at it
