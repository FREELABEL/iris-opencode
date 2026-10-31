// `iris daemon update --node <name>` and the "is it behind main" line in `iris hive nodes list`
// (#191614). The update itself runs ON the node (daemon-update.ts), started by a Hive task the
// way `iris hive run` starts one; this side only dispatches it and then watches the hub.

import { apiBase, isSha, parseDaemonVersion, resolveRef, short } from "./daemon-update"

/**
 * The script the node's task runs. It calls the node's OWN `iris` with --detach-restart: the task
 * is a child of the daemon it is about to restart, so the swap + restart + verify run in a
 * detached process after a delay, once this task has reported back.
 */
export function remoteUpdateScript(sha: string, o: { force?: boolean; dryRun?: boolean; delaySec?: number; healthTimeoutSec?: number } = {}): string {
  if (!isSha(sha)) throw new Error(`refusing to dispatch a non-commit ref: ${sha}`)
  const flags = [
    "--ref",
    sha,
    ...(o.dryRun ? ["--dry-run"] : ["--detach-restart", "--restart-delay", String(o.delaySec ?? 10)]),
    ...(o.force ? ["--force"] : []),
    ...(o.healthTimeoutSec ? ["--health-timeout", String(o.healthTimeoutSec)] : []),
  ].join(" ")
  return [
    "#!/bin/bash",
    "set -e",
    'IRIS="$HOME/.iris/bin/iris"; [ -x "$IRIS" ] || IRIS="$(command -v iris || true)"',
    'if [ -z "$IRIS" ]; then echo "no iris CLI on this node" >&2; exit 3; fi',
    // A CLI that predates the command would print yargs help and exit 0 — read as success.
    'if ! "$IRIS" daemon update --help 2>&1 | grep -q -- "--detach-restart"; then',
    '  echo "this node\'s iris CLI has no \\"daemon update\\" yet — update it first: iris hive run <node> \\"iris update\\"" >&2; exit 4',
    "fi",
    `"$IRIS" daemon update ${flags}`,
  ].join("\n")
}

export type NodeCommitView = { commit: string | null; drift: boolean; text: string; behind: boolean | null }

/** One node's line: which commit, and whether it is behind main (null = cannot tell). */
export function describeNodeCommit(daemonVersion: unknown, mainSha: string | null, behindBy?: number | null): NodeCommitView {
  const v = parseDaemonVersion(daemonVersion)
  if (!v) {
    return { commit: null, drift: false, behind: null, text: `commit unknown (daemon ${daemonVersion ?? "reports no version"} — installed before \`iris daemon update\`)` }
  }
  const drift = v.drift ? " · LOCAL EDITS (files differ from the install)" : ""
  if (!mainSha) return { commit: v.commit, drift: v.drift, behind: null, text: `commit ${short(v.commit)}${drift}` }
  if (v.commit === mainSha) return { commit: v.commit, drift: v.drift, behind: false, text: `commit ${short(v.commit)} = main${drift}` }
  const n = typeof behindBy === "number" ? `${behindBy} commit(s) ` : ""
  return { commit: v.commit, drift: v.drift, behind: true, text: `commit ${short(v.commit)} · ${n}behind main (${short(mainSha)}) — iris daemon update --node <name>${drift}` }
}

/** How many commits `sha` is behind `mainSha`, from GitHub's compare API. null when unknown. */
export async function behindMain(sha: string, mainSha: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await fetcher(`${apiBase()}/compare/${sha}...${mainSha}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "iris-daemon-update" },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as any
    return typeof j?.ahead_by === "number" ? j.ahead_by : null
  } catch {
    return null
  }
}

/**
 * Wait until the hub says the node's daemon reports `sha`. The daemon freezes its commit at
 * startup, so an old process can never report the new one: a match means the new code runs.
 */
export async function waitForNodeCommit(
  readVersion: () => Promise<unknown>,
  sha: string,
  o: { timeoutMs: number; intervalMs?: number; onTick?: (seen: string | null) => void; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ ok: boolean; seen: string | null }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const deadline = now() + o.timeoutMs
  let seen: string | null = null
  while (now() < deadline) {
    try {
      seen = parseDaemonVersion(await readVersion())?.commit ?? null
    } catch {
      /* transient hub error — keep waiting */
    }
    o.onTick?.(seen)
    if (seen === sha) return { ok: true, seen }
    await sleep(o.intervalMs ?? 10000)
  }
  return { ok: false, seen }
}

/** Every node's commit view, resolving main once and each distinct commit's distance once. */
export async function commitViews(versions: unknown[], fetcher: typeof fetch = fetch): Promise<{ main: string | null; byIndex: NodeCommitView[] }> {
  let main: string | null = null
  try {
    main = await resolveRef("main", fetcher)
  } catch {
    main = null
  }
  const distinct = [...new Set(versions.map((v) => parseDaemonVersion(v)?.commit).filter((c): c is string => !!c && c !== main))]
  const behind = new Map<string, number | null>()
  if (main) await Promise.all(distinct.map(async (c) => behind.set(c, await behindMain(c, main!, fetcher))))
  return {
    main,
    byIndex: versions.map((v) => {
      const c = parseDaemonVersion(v)?.commit
      return describeNodeCommit(v, main, c ? behind.get(c) : null)
    }),
  }
}
