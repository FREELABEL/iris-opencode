/**
 * `iris hive vaults` — encrypted, partitioned vaults for the patient data PHI tasks keep on a node.
 *
 * NOT `iris hive vault` (singular): that is sovereign replicated file storage. These vaults are
 * where a PHI task's outputs land — its full result, screenshots, workspace and portal
 * checkpoint — sealed with AES-256-GCM under a key that belongs to ONE vault, bound to ONE node
 * and optionally ONE bloq. A task for bloq X can only open X's vault. A PHI task gets one
 * automatically (no flag needed); these commands are for pre-creating one with a passphrase,
 * locking, unlocking, listing, and destroying.
 *
 * WHY THE CLI TALKS TO THE LOCAL DAEMON, not to its own files: a passphrase vault's key lives
 * only in the memory of the daemon that runs the PHI tasks, so `unlock` must happen there.
 * `list --all` asks the server instead, which only ever holds what nodes report: names, bloq,
 * lock state, size — never contents.
 *
 * DESTROY IS A CRYPTO-SHRED: the vault key is deleted from the OS keystore first, which makes
 * everything in the vault unrecoverable — including any copy a backup made. There is no undo.
 */

import { cmd } from "./cmd"
import { bridgeFetch, irisFetch, IRIS_API, requireAuth, dim, bold, success } from "./iris-api"
import { createInterface } from "readline"

export interface VaultSummary {
  name: string
  bloq_id: string | null
  node_id?: string | null
  locked: boolean
  key_source?: string | null
  files: number
  bytes: number
  escrow?: string | null
  last_write_at?: string | null
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n || 0} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** One line per vault. Deliberately has no field for contents — there is nothing to leak here. */
export function formatVaultRow(v: VaultSummary, node?: string): string {
  const state = v.locked ? "locked" : "unlocked"
  return [
    v.name.padEnd(26),
    `bloq ${v.bloq_id ?? "-"}`.padEnd(12),
    node ? `node ${node}`.padEnd(22) : "",
    state.padEnd(9),
    `${v.files} file(s)`.padEnd(11),
    humanBytes(v.bytes).padEnd(9),
    v.key_source ? `key:${v.key_source}` : "",
    v.escrow ? `escrow:${v.escrow}` : "",
  ].filter(Boolean).join(" ")
}

/** The daemon mounts routes under /daemon when embedded in the bridge, at / when standalone. */
async function daemon(path: string, init: RequestInit = {}): Promise<any> {
  const opts = { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> || {}) } }
  let res: Response
  let body: any
  try {
    res = await bridgeFetch(`/daemon${path}`, opts)
    body = await res.json().catch(() => ({}))
    // A 404 WITHOUT our error code is "no such route" (a standalone daemon mounts at /), not
    // "no such vault" — retry unprefixed once.
    if (res.status === 404 && body.error !== "not_found") {
      res = await bridgeFetch(path, opts)
      body = await res.json().catch(() => ({}))
    }
  } catch {
    throw new Error("the IRIS daemon is not running on this machine — start it with `iris-daemon start` (vault keys never leave the node they live on)")
  }
  if (!res.ok) throw new Error(body.message || body.error || `daemon returned HTTP ${res.status}`)
  return body
}

function hidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    ;(rl as any)._writeToOutput = (s: string) => { if (s.includes(question)) process.stderr.write(s) }
    rl.question(question, (a) => { rl.close(); process.stderr.write("\n"); resolve(a) })
  })
}

async function readPassphrase(confirm: boolean, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString("utf8").split("\n")[0]
  }
  const p = await hidden("Vault passphrase: ")
  if (confirm && (await hidden("Again: ")) !== p) throw new Error("passphrases did not match")
  return p
}

const fail = (e: unknown) => {
  console.error(`  ${(e as Error).message}`)
  process.exit(1)
}

const CreateCommand = cmd({
  command: "create <name>",
  describe: "create an encrypted vault on THIS node (key in the OS keychain, or --passphrase)",
  builder: (y) => y
    .positional("name", { type: "string", demandOption: true, describe: "vault name (letters, digits, . _ -)" })
    .option("encrypted", { type: "boolean", default: true, describe: "always on — every vault is encrypted (accepted for clarity)" })
    .option("bloq", { type: "string", describe: "bind to this bloq: only tasks for it can open the vault" })
    .option("node", { type: "string", describe: "the node to create it on (must be this machine — keys never travel)" })
    .option("passphrase", { type: "boolean", default: false, describe: "key from a passphrase instead of the keychain: stays locked after every restart until you unlock it" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "read the passphrase from stdin (first line)" })
    .option("json", { type: "boolean", default: false }),
  async handler(args) {
    try {
      if (args.encrypted === false) throw new Error("unencrypted vaults do not exist — drop --no-encrypted")
      const passphrase = args.passphrase || args["passphrase-stdin"] ? await readPassphrase(true, !!args["passphrase-stdin"]) : null
      const r = await daemon("/vaults", { method: "POST", body: JSON.stringify({ name: args.name, bloq_id: args.bloq ?? null, node: args.node ?? null, passphrase }) })
      if (args.json) return console.log(JSON.stringify(r.vault, null, 2))
      console.log(`  ${success("✓")} Created encrypted vault ${bold(r.vault.name)}${r.vault.bloq_id ? ` for bloq ${r.vault.bloq_id}` : ""}`)
      console.log(`  ${dim(`key: ${r.vault.key_source} · escrow: ${r.vault.escrow}${r.vault.escrow === "pending" ? " (retried on the next PHI task)" : ""}`)}`)
      if (r.vault.key_source === "passphrase") console.log(`  ${dim("Locks on every daemon restart — PHI tasks for this bloq wait until: iris hive vaults unlock " + r.vault.name)}`)
    } catch (e) { fail(e) }
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "vaults: name, bloq, node, locked/unlocked, size — never contents",
  builder: (y) => y
    .option("all", { type: "boolean", default: false, describe: "every node you own, as last reported to the server" })
    .option("node", { type: "string", describe: "only this node (implies --all)" })
    .option("json", { type: "boolean", default: false }),
  async handler(args) {
    try {
      if (args.all || args.node) {
        if (!(await requireAuth())) return
        const res = await irisFetch("/api/v1/hive/vault-credentials", {}, IRIS_API)
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`)
        const nodes = (body.nodes || []).filter((n: any) => !args.node || n.node_id === args.node || n.node_name === args.node)
        if (args.json) return console.log(JSON.stringify(nodes.map((n: any) => ({ node_id: n.node_id, node_name: n.node_name, disk_encrypted: n.disk_encrypted, encrypted_vaults: n.encrypted_vaults || [] })), null, 2))
        for (const n of nodes) {
          console.log(`  ${bold(n.node_name)} ${dim(n.disk_encrypted ? "disk encrypted" : "disk NOT confirmed encrypted — PHI tasks will not route here")}`)
          const vs: VaultSummary[] = n.encrypted_vaults || []
          if (!vs.length) console.log(`    ${dim("(no encrypted vaults)")}`)
          for (const v of vs) console.log(`    ${formatVaultRow(v)}`)
        }
        return
      }
      const r = await daemon("/vaults")
      if (args.json) return console.log(JSON.stringify(r, null, 2))
      if (!r.vaults.length) return console.log(`  ${dim("No encrypted vaults on this node. A PHI task creates one for its bloq automatically.")}`)
      for (const v of r.vaults as VaultSummary[]) console.log(`  ${formatVaultRow(v)}`)
      console.log(`  ${dim(`PHI working copies are crypto-shredded after ${r.retention_days} days (HIVE_PHI_RETENTION_DAYS).`)}`)
    } catch (e) { fail(e) }
  },
})

const LockCommand = cmd({
  command: "lock <name>",
  describe: "lock a vault: PHI tasks for its bloq are refused until it is unlocked",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }),
  async handler(args) {
    try {
      const r = await daemon(`/vaults/${encodeURIComponent(String(args.name))}/lock`, { method: "POST", body: "{}" })
      console.log(`  ${success("✓")} ${bold(r.vault.name)} locked`)
    } catch (e) { fail(e) }
  },
})

const UnlockCommand = cmd({
  command: "unlock <name>",
  describe: "unlock a vault (asks for the passphrase of a passphrase vault)",
  builder: (y) => y
    .positional("name", { type: "string", demandOption: true })
    .option("passphrase-stdin", { type: "boolean", default: false }),
  async handler(args) {
    try {
      const name = String(args.name)
      const list = await daemon("/vaults")
      const v = (list.vaults as any[]).find((x) => x.name === name)
      if (!v) throw new Error(`no vault named "${name}" on this node`)
      const passphrase = v.key_source === "passphrase" ? await readPassphrase(false, !!args["passphrase-stdin"]) : null
      const r = await daemon(`/vaults/${encodeURIComponent(name)}/unlock`, { method: "POST", body: JSON.stringify({ passphrase }) })
      console.log(`  ${success("✓")} ${bold(r.vault.name)} unlocked ${dim(`(escrow: ${r.vault.escrow})`)}`)
    } catch (e) { fail(e) }
  },
})

const DestroyCommand = cmd({
  command: "destroy <name>",
  describe: "crypto-shred a vault: its key is deleted, so its contents are unrecoverable (no undo)",
  builder: (y) => y
    .positional("name", { type: "string", demandOption: true })
    .option("yes", { type: "boolean", default: false, describe: "skip the confirmation" }),
  async handler(args) {
    try {
      const name = String(args.name)
      if (!args.yes) {
        const typed = await new Promise<string>((resolve) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          rl.question(`Destroy vault ${name}? Everything in it becomes unrecoverable. Type the name to confirm: `, (a) => { rl.close(); resolve(a) })
        })
        if (typed.trim() !== name) throw new Error("not confirmed — nothing was destroyed")
      }
      const r = await daemon(`/vaults/${encodeURIComponent(name)}`, { method: "DELETE" })
      console.log(`  ${success("✓")} Destroyed ${bold(name)}: ${r.destroyed.files} file(s), ${humanBytes(r.destroyed.bytes)} crypto-shredded ${dim("(audited, counts only)")}`)
    } catch (e) { fail(e) }
  },
})

export const HiveVaultsCommandExport = cmd({
  command: "vaults",
  describe: "encrypted, per-bloq vaults for the patient data PHI tasks keep on a node",
  builder: (y) => y
    .command(CreateCommand).command(ListCommand).command(LockCommand)
    .command(UnlockCommand).command(DestroyCommand)
    .demandCommand(1, "Specify: create, list, lock, unlock, destroy"),
  async handler() {},
})
