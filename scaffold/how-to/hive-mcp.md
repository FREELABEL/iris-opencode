---
category: Infrastructure
level: intermediate
tags: [hive, mcp, nodes, devices, argent, tools, iphone, ios, android, simulator, appium, device-control, tv, electron]
duration_min: 10
---
# How to: Let a machine in your Hive run an MCP server

## What this does

Gives one of your machines the ability to call an **MCP server** — and lets you reach that
server from anywhere, through the Hive, without being at the keyboard.

MCP already worked in one direction: `iris mcp serve` exposes IRIS's own tools to Claude Code,
Cursor and the rest, and `iris mcp add` lets the CLI call other people's servers. What it could
not do was run one **on a node**. Now a task can.

That matters most for things a cloud cannot do. Software Mansion's `argent` drives physical
iPhones over USB, Android over adb, Apple TV, and Electron apps — and all of that needs a real
machine with a real cable. A Mac in your office can now do it on request.

## The rule that makes it safe

**A task names a server. It never sends a command.**

The machine decides what it is willing to run, in a file only its owner can write. If a task
asks for a server that is not in that file, the answer is no — there is no "try it anyway"
branch. So the worst a compromised account can do is ask a machine to run something its owner
already approved.

## Steps

**1. Allow a server on the machine**

Create `~/.iris/mcp-servers.json` on the node:

```json
{
  "argent": {
    "command": "npx",
    "args": ["-y", "@swmansion/argent@0.24.0", "mcp"],
    "description": "iOS/Android/TV/Electron device control"
  }
}
```

A file you already have from Claude Desktop or Cursor works unmodified — the `mcpServers`
wrapper is accepted as well as the bare map. Pin the version; `@latest` means a different
server tomorrow.

**2. Restart the daemon so it re-reads the file**

```bash
iris-bridge restart      # or: ~/.iris/bridge/daemonctl restart
```

**3. Check the machine is advertising it**

```bash
iris hive nodes list
```

The node reports which servers it holds, by name. The commands stay on the machine — the fleet
needs to know *which* servers a node offers so work can be routed to it, and has no business
knowing how they are launched.

**4. Ask it what the server can do**

An `mcp_call` with no tool named returns `tools/list` — the first end-to-end proof that the
cloud dispatched, the node checked its allowlist, spawned the server, and answered:

```bash
iris hive tasks create --type mcp_call --node <name> --config '{"server":"argent"}'
```

It waits for the result and prints it. Add `--queue` to dispatch and walk away
(`iris hive tasks get <id>` reads it later).

**5. Call a tool**

```bash
iris hive tasks create --type mcp_call --node <name> \
  --config '{"server":"argent","tool":"list-devices","arguments":{},"timeout_ms":240000}'
```

Under it, that is one task of type `mcp_call` — the same thing the dashboard or an agent
dispatches:

```json
{ "type": "mcp_call",
  "config": {
    "server": "argent",
    "tool": "list-devices",
    "arguments": {},
    "timeout_ms": 240000
  } }
```

The result comes back like any other task result:

```json
{ "ok": true, "server": "argent", "tool": "list-devices",
  "result": { "content": [ { "type": "text", "text": "{\"devices\": [], \"avds\": []}" } ] } }
```

## Common problems

**`MCP server 'x' is not allowed on this node. Allowed: …`**
Exactly what it says, and it names what *is* allowed plus the path to the file. Add it there, on
that machine, and restart.

**`MCP server list unreadable — … is not valid JSON`**
Different from "not allowed", deliberately. A trailing comma would otherwise silently disable
every MCP tool on the node and the refusal would send you to edit a list that was already
correct.

**`no MCP servers are configured on this node`**
There is no file yet. The message includes the path to create.

**`MCP server did not complete initialize within …`**
Usually a cold `npx` downloading the package on first run. Raise it with `timeout_ms`, or run
the server once by hand on that machine to warm the cache.

**A big `tools/list` comes back cut off**
Task output is capped at 50,000 bytes. A server with 75 tools exceeds that. Ask for a specific
tool instead of listing, or read the list on the machine itself.

## Worth knowing before you wire it into an agent

An MCP server can expose a *lot* of tools — `argent` alone publishes 75. Handing all of them to
an agent is the fastest way to make a small model worse at choosing, because every tool is
schema the model reads before it has done anything. Reach them through a task, or put them
behind one router tool, rather than adding them to an agent's list wholesale.

## Related

- `iris mcp add` / `iris mcp tools` — MCP servers for the CLI itself, not for a node
- `iris hive nodes list` — which machines hold which servers
- `iris hive tasks create` — dispatch ANY task type to a node, not just `mcp_call`
- `iris hive run` — a shell command on a machine, when you do not need MCP at all
