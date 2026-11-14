import { connect } from "net"

/**
 * Is a TCP port open, and what does it say first? (#191565)
 *
 * `iris hive ssh <ip>` and `iris hive probe` used `nc -z -G <sec>`. `-G` is the macOS (BSD) nc's
 * connect timeout; the OpenBSD nc that Ubuntu ships has no `-G` and exits 1 with a usage message
 * — so on every Linux machine every port read as "closed", and `hive ssh 127.0.0.1` told the
 * person to enable an ssh server that was already answering. Measured on iris-hive-001,
 * 2026-10-28: `nc -z -G 1 127.0.0.1 22` → "invalid option -- 'G'", exit 1.
 *
 * A socket from the runtime needs no external tool and behaves the same on every OS.
 */
export async function tcpProbe(
  host: string,
  port: number,
  opts: { timeoutMs?: number; banner?: boolean } = {},
): Promise<{ open: boolean; banner: string | null }> {
  const timeoutMs = opts.timeoutMs ?? 1500
  return new Promise((resolve) => {
    let done = false
    let opened = false
    let text = ""
    const sock = connect({ host, port })
    const finish = (open: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      const line = text.split(/\r?\n/)[0].trim()
      resolve({ open, banner: line || null })
    }
    const timer = setTimeout(() => finish(opened), timeoutMs)
    sock.on("connect", () => {
      opened = true
      if (!opts.banner) finish(true)
    })
    sock.on("data", (d) => {
      text += d.toString("utf8")
      if (text.includes("\n") || text.length > 512) finish(true)
    })
    sock.on("error", () => finish(opened))
    sock.on("close", () => finish(opened))
  })
}
