---
category: Infrastructure
level: intermediate
tags: [hive, github, ci, github-actions, runners, self-hosted]
duration_min: 10
---
# How to: Run your GitHub Actions on your own Hive machines

## What this does

Turns any machine in your Hive into a **self-hosted GitHub Actions runner** for a repo. Hosted
macOS and Windows minutes are the expensive part of CI; a Mac on your desk or a Linux box in the
closet is already paid for. If it runs the IRIS daemon, one command makes it take your jobs.

```bash
iris hive runner add my-mac --repo acme/app
```

The node downloads GitHub's own runner, registers it with the repo, and starts it as a service so
it survives reboots. Nothing is installed on GitHub's side except the runner entry.

## Prerequisites

- `iris auth login`, and the machine is a Hive node (`iris hive nodes list` shows it **online**).
  Not there yet? On that machine: `iris node install`.
- A GitHub login on **this** machine with **admin** on the repo: `gh auth login`, or
  `GITHUB_TOKEN` / `GH_TOKEN` in the environment.
- The node is **macOS or Linux**. Windows nodes are refused for now.

## Steps

**1. Add the runner**

```bash
iris hive runner add iris-hive-001 --repo acme/website
iris hive runner add my-mac --repo acme/app --labels macos-build
```

```
Installing GitHub Actions runner iris-hive-001 for acme/website on iris-hive-001 (actions-runner 2.338.0)
  Downloading actions-runner 2.338.0 for linux-x64
  Registering iris-hive-001 with github.com/acme/website
iris-hive-001 is online on GitHub. It runs on iris-hive-001 (linux-x64).
Use it in a workflow with:  runs-on: [self-hosted, iris-hive]
```

Every runner gets the label `iris-hive`; `--labels` adds more. The runner's name defaults to
`iris-<node>`; pick your own with `--name`. Running `add` again on the same node and repo replaces
the runner rather than adding a second one.

**2. Point a workflow at it**

```yaml
jobs:
  build:
    runs-on: [self-hosted, iris-hive]          # any of your Hive runners
  build-mac:
    runs-on: [self-hosted, iris-hive, macOS]   # only a Mac one
```

GitHub adds the OS and CPU labels (`Linux`, `macOS`, `X64`, `ARM64`) itself.

**3. See them**

```bash
iris hive runner list                     # every repo you added runners to from this machine
iris hive runner list --repo acme/website # every runner on one repo
```

```
acme/website
  ● online  iris-hive-001  on iris-hive-001  self-hosted, Linux, X64, iris-hive
```

**4. Take one back**

```bash
iris hive runner remove iris-hive-001 --repo acme/website
```

It stops the service, unregisters the runner from GitHub and deletes its folder on the node.

## How it works, and what to know

- The install runs as an ordinary Hive task on the node. The runner lives in
  `~/.iris/runners/<owner>-<repo>-<name>`; `~/.iris/runners.json` on your machine records what you added.
- **macOS:** installed as a user LaunchAgent — no `sudo`. An Apple-silicon Mac gets the native
  arm64 runner even when the IRIS daemon itself runs under Rosetta.
- **Linux:** installed as a systemd service when the node has passwordless `sudo`. Without it, the
  runner is started in the background and **will not come back after a reboot** — the command
  says so. Give the node passwordless sudo and run `add` again to make it a service.
- **Your GitHub login never leaves your machine.** The node only receives a registration (or
  remove) token, which is single-purpose and expires in about an hour, and is never printed.
- A self-hosted runner runs whatever the workflow says, as the user the daemon runs as. Only add
  runners to repos whose workflows you trust — never to a public repo that runs pull requests from forks.

## When it does not work

| You see | Fix |
|---|---|
| `No GitHub login on this machine` | `gh auth login` |
| `GitHub said 403/404 …` | Your GitHub login needs admin on that repo, or the name is wrong. `gh auth refresh -s repo` |
| `No Hive node called …` | `iris hive nodes list`; to add this machine, `iris node install` |
| `… is offline, so it cannot take the task` | Start the daemon on that machine (`iris-daemon start`) and retry |
| `… is a Windows machine` | Not supported yet — use a macOS or Linux node |
| `config.sh exited 1` on Linux | Usually missing .NET dependencies: on the node, `sudo ~/.iris/runners/<folder>/bin/installdependencies.sh` |
| Runner shows **offline** in `list` | The machine is asleep or the service stopped; on the node, `cd ~/.iris/runners/<folder> && ./svc.sh status` |
