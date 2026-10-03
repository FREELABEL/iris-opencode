/**
 * `iris hive ssh <node>` — a shell on one of YOUR Hive nodes, by name.
 *
 * The address comes from hive-tailscale.ts (cache → what the node advertised → the tailnet
 * peer list), the same resolver `hive fs` and `hive vault` ride on. This module adds the one
 * thing that resolver could not do: learn the login user on a node whose username differs
 * from yours, by asking the node's own daemon over the Hive task rail.
 */
import { hiveFetch } from "./platform-hive-nodes"
import { fromHiveTask } from "./hive-script-result"

/** POSIX-ish login names — what `id -un` can print. */
const USERNAME = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i

/**
 * The username in a task's stdout.
 *
 * The Hive transport returns a PTY stream, not clean stdout (#182004): the wrapper's command
 * line, a prompt and escape codes can surround the answer. So the answer is the LAST line that
 * is wholly a login name and is not one of the transport's own words. A wrong pick costs
 * nothing — the caller only keeps a user an ssh login has accepted.
 */
export function pickUsername(stdout: string): string | null {
  const NOISE = new Set(["bash", "sh", "zsh", "set", "exit", "id", "true", "logout"])
  const lines = stdout
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => USERNAME.test(l) && !NOISE.has(l.toLowerCase()))
  return lines.length ? lines[lines.length - 1] : null
}

/** Ask a node which user its daemon runs as. null when the node cannot answer in time. */
export async function askNodeUser(userId: number, nodeId: string, timeoutSec = 30): Promise<string | null> {
  const create = await hiveFetch(`/api/v6/nodes/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      title: "iris hive ssh: which user",
      type: "sandbox_execute",
      node_id: nodeId,
      prompt: "#!/bin/bash\nid -un",
      config: { timeout_seconds: timeoutSec },
      timeout_seconds: timeoutSec,
    }),
  })
  if (!create.ok) return null
  const taskId = ((await create.json()) as { task?: { id?: string } }).task?.id
  if (!taskId) return null

  const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
  const deadline = Date.now() + (timeoutSec + 10) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const r = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
    if (!r.ok) return null
    const t = ((await r.json()) as { task: any }).task
    if (terminal.has(t?.status)) return pickUsername(fromHiveTask(t).stdout ?? "")
  }
  return null
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** An IP address keeps the old meaning of `hive ssh`: test which users can log in there. */
export function isIpTarget(target: string): boolean {
  return IPV4.test(target.trim())
}

/** The ssh argv for an interactive session, or for one command when `remote` is given. */
export function sshArgs(dest: string, remote?: string): string[] {
  // accept-new: the tailnet has already authenticated this peer by its WireGuard key, so a
  // first-contact prompt adds a question and no safety. A CHANGED key is still refused.
  const base = ["-o", "StrictHostKeyChecking=accept-new"]
  return remote ? [...base, dest, remote] : [...base, dest]
}
