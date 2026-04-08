# How to: Connect a machine to the Hive and dispatch a task

## What this does

Connects the user's machine to the **IRIS Hive** — a distributed compute mesh where any registered node can execute tasks (code generation, sandbox runs, scraping, SOM batches, custom scripts) dispatched from the IRIS platform. This is the differentiator vs. other CLIs: your machine becomes part of a private agent network.

## Prerequisites

- IRIS CLI installed and authenticated (`iris-login` complete — see `iris-login.md`)
- Node.js installed (`node --version` should return v18+ — the daemon is a Node process)
- The Hive daemon installed at `~/.iris/bridge/` (the installer scaffolds this if Node was present at install time)

If the daemon directory doesn't exist:

```bash
$ ls ~/.iris/bridge/daemon.js
# If missing, re-run the IRIS installer with Node present, OR clone manually:
$ git clone https://github.com/FREELABEL/iris-bridge.git ~/.iris/bridge && cd ~/.iris/bridge && npm install --production
```

## Step 1: Start the daemon

```bash
$ iris-daemon start
```

This launches the daemon as a background process listening on `localhost:3200` and connecting to the IRIS platform via Pusher (private channel `private-node.{nodeId}`) for real-time task dispatch.

If the daemon detects an SDK token in `~/.iris/sdk/.env` but no node API key, it **self-registers** with the platform automatically — no manual step. This is the self-healing flow shipped in the iris-login installer (March 2026).

Verify it's running:

```bash
$ iris-daemon status
✓ Daemon running (pid 12345, uptime 00:02:14)
✓ Node ID: node_live_abc123...
✓ Connected to Pusher: yes
✓ Heartbeat: every 30s, last sent 12s ago
✓ Active tasks: 0
```

Or hit the local queue endpoint directly:

```bash
$ curl http://localhost:3200/daemon/queue | jq
```

This shows active tasks with titles, types, PIDs, and uptime — useful for debugging.

## Step 2: Verify the node appears in the platform

```bash
$ iris hive nodes list
```

Or visit the Hive dashboard in the platform UI: `https://app.heyiris.io/hive`. Your machine should appear as a green "online" node within ~30s of starting the daemon.

## Step 3: Dispatch a task

The daemon supports these task types out of the box:

| Type | What it does |
|---|---|
| `code_generation` | Run a code-gen workflow on the node |
| `sandbox_execute` | Execute a script in an isolated sandbox |
| `test_run` | Run a test suite |
| `scaffold_workspace` | Set up a new project workspace |
| `run_persistent` | Long-running process the daemon supervises |
| `artisan` | Run a Laravel artisan command |
| `som` / `som_batch` | SOM outreach pipeline (see `outreach-campaign.md`) |
| `leadgen` | Lead generation scrapers |
| `custom` | Arbitrary shell command |

Dispatch a one-off task:

```bash
$ iris hive task dispatch --type=sandbox_execute --script="echo hello from $(hostname)"
```

Or schedule a recurring task (campaign template style):

```bash
$ iris hive task dispatch --type=som_batch --schedule="0 9 * * *" --segment=creators
```

Recurring tasks create a `bloq_scheduled_jobs` row on the platform, picked up by `ProcessAgentJobs` in fl-api, which routes via `ExecuteAgentJob` → `IrisApiService::dispatchHiveTask()` → the daemon's task queue.

## Step 4: Stop or restart

```bash
$ iris-daemon stop
$ iris-daemon restart
```

The daemon writes logs to `~/.iris/bridge/logs/daemon.log` with timestamps in the format `[HH:MM:SS AM/PM]`.

## Expected output (full happy path)

```bash
$ iris-daemon start
✓ Daemon started (pid 12345)
✓ Loading SDK credentials from ~/.iris/sdk/.env
✓ Auto-registering node...
✓ Node registered: node_live_abc123 (saved to ~/.iris/bridge/.env)
✓ Connecting to Pusher private-node.node_live_abc123...
✓ Connected. Listening for tasks.
[03:42:11 PM] Heartbeat sent

$ iris hive task dispatch --type=sandbox_execute --script="uname -a"
✓ Task dispatched: task_xyz789
✓ Routing to node: node_live_abc123
[03:42:23 PM] Task task_xyz789 received
[03:42:23 PM] Executing: uname -a
[03:42:23 PM] Task task_xyz789 completed (12ms)
✓ Result: Darwin alex-mac 23.5.0 ...
```

## Common errors

### `Daemon failed to start: EADDRINUSE port 3200`

**Cause:** Another process is using port 3200, or a previous daemon didn't shut down cleanly.
**Fix:** `lsof -i :3200` to find the process, `kill <pid>`, then `iris-daemon start` again. If the process is the daemon itself in a zombie state, `pkill -f daemon.js` first.

### Daemon starts but never registers (no node ID)

**Cause:** No SDK token found in `~/.iris/sdk/.env`.
**Fix:** Run `iris-login` first. The daemon auto-registers on next start.

### Daemon registers but doesn't appear in `iris hive nodes list`

**Cause:** Pusher connection failed (firewall, proxy, or platform outage).
**Fix:** Check `~/.iris/bridge/logs/daemon.log` for Pusher connection errors. If Pusher is blocked by a corporate firewall, the daemon falls back to HTTP polling but with higher latency. Test platform reachability: `curl -I https://app.heyiris.io`.

### Task dispatched but never executed

**Cause:** Daemon is registered but not subscribed to the right channel, or the task type isn't recognized by this daemon version.
**Fix:** `iris-daemon restart`, then `curl http://localhost:3200/daemon/queue` to confirm the task arrived. If the queue is empty, the dispatch routed to a different node — check `iris hive nodes list` for which nodes are online.

### `Error: Bridge not installed at ~/.iris/bridge`

**Cause:** Installer ran without Node.js present, so the bridge component was skipped.
**Fix:** Install Node.js (https://nodejs.org), then re-run the IRIS installer, OR clone manually as shown in Prerequisites.

## What auto-chaining does (advanced)

When a `discover` task completes on a Hive node, the daemon automatically dispatches a follow-up `som_batch` task on the same node (runs `npm run som:all`). This is the SOM auto-pipeline.

To disable: edit `~/.iris/config.json` and set `chain_outreach: false`.

## Related recipes

- `iris-login.md` — must be done first
- `outreach-campaign.md` — the most common task type to dispatch
- `lead-to-proposal.md` — leads generated by Hive tasks flow into this workflow
