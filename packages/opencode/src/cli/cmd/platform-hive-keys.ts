import { cmd } from "./cmd"
import { UI } from "../ui"
import { dim, bold, success, highlight } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { generateKeypair, ENVELOPE_VERSION } from "../lib/envelope"
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/**
 * iris hive keys — the node's envelope keypair (#177946 phase 3).
 *
 * A node generates its X25519 keypair LOCALLY and uploads only the public half. The private key
 * never leaves this machine, and there is no server column it could land in even if it were sent.
 * That is what lets a transfer be addressed to a recipient the platform cannot itself read, which
 * is the property the phase-2 construction could not express at all — its key was
 * SHA-256(the sender's own API key), so "encrypted" only ever meant "encrypted to myself".
 *
 * WITHOUT A REGISTERED KEY A NODE CANNOT RECEIVE ENVELOPE TRANSFERS, and that is deliberate:
 * the send path fails closed rather than falling back to sender-key encryption. So this command
 * has to exist and be run before the cutover, not alongside it.
 */

const KEY_DIR = join(homedir(), ".iris", "keys")
const KEY_FILE = join(KEY_DIR, "envelope.json")

interface StoredKey {
  version: string
  public_key: string
  secret_key: string
  created_at: string
}

/** Read this machine's envelope keypair, or null. */
export function loadLocalKeypair(): { publicKey: Buffer; secretKey: Buffer } | null {
  try {
    if (!existsSync(KEY_FILE)) return null
    const stored: StoredKey = JSON.parse(readFileSync(KEY_FILE, "utf-8"))
    return {
      publicKey: Buffer.from(stored.public_key, "base64"),
      secretKey: Buffer.from(stored.secret_key, "base64"),
    }
  } catch {
    return null
  }
}

function saveLocalKeypair(publicKey: Buffer, secretKey: Buffer): void {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 })

  const payload: StoredKey = {
    version: ENVELOPE_VERSION,
    public_key: publicKey.toString("base64"),
    secret_key: secretKey.toString("base64"),
    created_at: new Date().toISOString(),
  }

  writeFileSync(KEY_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
  // Set explicitly as well as via the mode option: writeFileSync's mode is only applied when it
  // CREATES the file, so rotating over an existing 0644 file would silently keep the old mode.
  chmodSync(KEY_FILE, 0o600)
}

const HiveKeysRegisterCommand = cmd({
  command: "register",
  describe: "generate this node's envelope keypair and register the public half",
  builder: (yargs) =>
    yargs
      .option("rotate", {
        type: "boolean",
        default: false,
        describe: "replace an existing local key (the old one is revoked server-side)",
      })
      .option("tenant", { type: "string", describe: "tenant slug this node belongs to" })
      .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const existing = loadLocalKeypair()

    if (existing && !argv.rotate) {
      // Refusing rather than silently regenerating: overwriting the local secret would orphan
      // every transfer already wrapped to the old public key, and the failure would only show up
      // later as files that cannot be opened.
      const message = "this node already has an envelope key — pass --rotate to replace it (transfers wrapped to the old key will no longer be openable)"
      if (argv.json) {
        console.log(JSON.stringify({ success: false, error: "key_exists", message }))
      } else {
        UI.error(message)
      }
      process.exit(1)
    }

    const { publicKey, secretKey } = generateKeypair()

    // Store BEFORE registering. If the order were reversed and the write failed, the server would
    // advertise a public key whose private half exists nowhere — and every transfer wrapped to it
    // would be undecryptable by anyone, silently.
    saveLocalKeypair(publicKey, secretKey)

    const body: Record<string, string> = { public_key: publicKey.toString("base64") }
    if (argv.tenant) body.tenant_slug = argv.tenant as string

    const res = await hiveFetch("/api/v6/hive/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      const message = (data as any)?.message ?? `registration failed (HTTP ${res.status})`
      if (argv.json) {
        console.log(JSON.stringify({ success: false, error: (data as any)?.error ?? "http_error", message }))
      } else {
        UI.error(message)
        UI.empty()
        // The local key is kept on purpose — re-running without --rotate would otherwise be
        // blocked by a key the server never accepted, and rotating again would churn a fresh
        // secret for no reason.
        UI.println(dim("  local key kept — re-run `iris hive keys register --rotate` once the API is reachable"))
      }
      process.exit(1)
    }

    if (argv.json) {
      console.log(JSON.stringify({ success: true, key_id: (data as any)?.key_id, public_key: body.public_key }))
      return
    }

    UI.empty()
    UI.println(`  ${success("✓")} ${bold("Envelope key registered")}`)
    UI.println(`  ${dim("owner")}      ${(data as any)?.owner ?? "this node"}`)
    UI.println(`  ${dim("public key")} ${highlight(body.public_key)}`)
    UI.println(`  ${dim("secret")}     ${KEY_FILE} ${dim("(0600, never uploaded)")}`)
    UI.empty()
    if (existing) UI.println(dim("  the previous key was superseded and revoked server-side"))
  },
})

const HiveKeysShowCommand = cmd({
  command: "show",
  describe: "show this node's envelope public key",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const kp = loadLocalKeypair()

    if (!kp) {
      const message = "no envelope key on this machine — run `iris hive keys register`"
      if (argv.json) console.log(JSON.stringify({ success: false, error: "no_key", message }))
      else UI.error(message)
      process.exit(1)
    }

    // Permissions are checked, not assumed. A world-readable secret is the whole scheme undone,
    // and it is the kind of thing a stray `chmod -R` does without anyone noticing.
    let mode: string | null = null
    try {
      mode = (statSync(KEY_FILE).mode & 0o777).toString(8)
    } catch {}

    if (argv.json) {
      console.log(JSON.stringify({ success: true, public_key: kp.publicKey.toString("base64"), mode }))
      return
    }

    UI.empty()
    UI.println(`  ${dim("public key")} ${highlight(kp.publicKey.toString("base64"))}`)
    UI.println(`  ${dim("secret")}     ${KEY_FILE}`)
    if (mode && mode !== "600") {
      UI.println(`  ${dim("mode")}       ${mode} ${bold("— expected 600; run: chmod 600 " + KEY_FILE)}`)
    }
    UI.empty()
  },
})

const HiveKeysCommand = cmd({
  command: "keys",
  describe: "manage this node's envelope encryption key",
  builder: (yargs) =>
    yargs.command(HiveKeysRegisterCommand).command(HiveKeysShowCommand).demandCommand(1, "Specify: register, show"),
  async handler() {},
})

export const HiveKeysCommandExport = HiveKeysCommand
