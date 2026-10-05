/**
 * Read one lead's two-sided email thread from Mail.app over AppleEvents (2026-09-17).
 *
 * The bridge's Apple Mail path could not deliver a message: it reads Mail's Envelope Index, which
 * needs the DAEMON's Full Disk Access (503 without it), returns envelopes with no Message-ID and no
 * body, and only searches mail FROM the lead. AppleEvents need Automation permission — which the
 * operator's terminal already holds — and read the same mailbox in both directions, with a stable
 * RFC Message-ID and the body. Measured on lead #28363: the ledger held 2 mails; this read 30
 * (18 inbound, 12 outbound) from one account in 26s.
 *
 * THE TRAP. A whose-clause over a large or unified mailbox does not fail safely: a timed-out
 * AppleEvent keeps running INSIDE Mail, pegged near 100% CPU for minutes, and every later request
 * queues behind it (measured: ~5 min to drain). So this reads ONE named account, date-bounded, with
 * bulk property fetches, and matches exact addresses in JS — never a name, never a substring.
 */
import { execFile } from "node:child_process"

// String.raw: the script's regex contains `\\/`, which a plain template literal would turn into `/`
// and end the regex early.
export const MAIL_THREAD_READER_JXA = String.raw`function run(argv) {
  const addr = String(argv[0] || "").trim().toLowerCase()
  const days = Number(argv[1] || 90)
  const acctName = String(argv[2] || "")
  const withBody = argv[3] === "body"
  if (!addr.includes("@") || !acctName) throw new Error("usage: <address> <days> <account> [body]")

  const Mail = Application("Mail")
  const cutoff = new Date(Date.now() - days * 864e5)
  const acct = Mail.accounts.byName(acctName)
  const emailOf = (s) => {
    const m = String(s || "").match(/<([^>]+)>/)
    return (m ? m[1] : String(s || "")).trim().toLowerCase()
  }
  const items = []
  const seen = {}
  const scanned = {}

  // Which mailboxes exist is account-specific (IMAP "Sent", Gmail "Sent Mail"). Use the mailbox
  // OBJECTS from the listing: a Gmail special folder listed as "Sent Mail" cannot be addressed with
  // byName("Sent Mail") — every call on it throws "Can't get object" (measured 2026-09-17).
  const boxes = acct.mailboxes()
  const named = boxes.map((mb) => ({ mb, name: mb.name() }))
  const inbox = named.find((b) => b.name.toUpperCase() === "INBOX")
  const sents = named.filter((b) => /(^|\/)sent( mail| messages)?$/i.test(b.name))

  const read = (box, direction) => {
    const mbName = box.name
    const msgs = box.mb.messages.whose({ dateReceived: { ">": cutoff } })
    // COUNT FIRST. A bulk property fetch on an EMPTY whose-result does not return [] in JXA — it
    // throws "Can't get object" (-1728), so a quiet mailbox would abort the whole read.
    const n = msgs.length
    scanned[mbName] = n
    if (n === 0) return
    const ids = msgs.messageId()
    const subj = msgs.subject()
    const dr = msgs.dateReceived()
    const ds = msgs.dateSent()
    const snd = msgs.sender()
    const to = direction === "outbound" ? msgs.toRecipients.address() : null
    const cc = direction === "outbound" ? msgs.ccRecipients.address() : null
    for (let i = 0; i < ids.length; i++) {
      const hit =
        direction === "inbound"
          ? emailOf(snd[i]) === addr
          : [...(to[i] || []), ...(cc[i] || [])].some((a) => String(a).trim().toLowerCase() === addr)
      if (!hit || !ids[i] || seen[ids[i]]) continue
      seen[ids[i]] = 1
      const item = {
        // RFC Message-ID: the same id on every machine and every mailbox copy of this message.
        external_message_id: "rfc822_" + ids[i],
        direction,
        from_identifier: direction === "inbound" ? emailOf(snd[i]) : acctName,
        subject: subj[i],
        sent_at: (ds[i] || dr[i]).toISOString(),
        channel: "apple_mail",
        metadata: { source: "apple_mail_applescript", account: acctName, mailbox: mbName, matched_address: addr },
      }
      if (withBody) {
        try {
          item.body = String(msgs[i].content()).slice(0, 20000)
        } catch (e) {
          item.body = ""
        }
      }
      items.push(item)
    }
  }

  if (inbox) read(inbox, "inbound")
  for (const box of sents) read(box, "outbound")
  return JSON.stringify({ account: acctName, address: addr, days, scanned, count: items.length, items })
}
`

export type MailThreadRead = { ok: true; items: any[]; scanned: Record<string, number> } | { ok: false; reason: string }

/** Is Mail answering at all? A busy Mail must not be handed more work — it would only queue. */
export function mailResponsive(timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", 'Application("Mail").accounts.name().length'], { timeout: timeoutMs }, (err, stdout) =>
      resolve(!err && /^\d+/.test(String(stdout).trim())),
    )
  })
}

export function readMailThread(address: string, days: number, account: string, withBody: boolean, timeoutMs = 120000): Promise<MailThreadRead> {
  return new Promise((resolve) => {
    const args = ["-l", "JavaScript", "-e", MAIL_THREAD_READER_JXA, address, String(days), account]
    if (withBody) args.push("body")
    execFile("osascript", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 240)
        const hint = /-1743|not authori[sz]ed/i.test(msg)
          ? " — grant this terminal Automation access to Mail (System Settings → Privacy & Security → Automation)"
          : /-1712|timed out/i.test(msg)
            ? " — Mail did not answer in time; it may still be working on this request, so do not retry immediately"
            : ""
        return resolve({ ok: false, reason: `Mail.app read failed for ${address} in "${account}": ${msg}${hint}` })
      }
      try {
        const d = JSON.parse(String(stdout))
        resolve({ ok: true, items: d.items ?? [], scanned: d.scanned ?? {} })
      } catch (e: any) {
        resolve({ ok: false, reason: `Mail.app returned unreadable output for ${address}: ${String(stdout).slice(0, 120)}` })
      }
    })
  })
}

/**
 * Drop items the ledger already holds under a DIFFERENT key. `iris mail send` logs a message at
 * send time with its own id; the same message read back from Sent Mail carries its RFC Message-ID.
 * Two writers, two keys, two rows — unless they are matched on what they share: direction,
 * subject, and a send time within a few minutes.
 */
export function withoutLedgerDuplicates(items: any[], existing: any[], windowMs = 5 * 60 * 1000): { keep: any[]; dropped: number } {
  const norm = (s: any) => String(s ?? "").trim().toLowerCase()
  // A row logged by hand often carries a DATE, not a time: measured on #28363, comm 5207 "IRIS +
  // Pathways Cheat Sheet" is stored at 2026-09-03T00:00:00Z while the message went at 16:14Z. A
  // five-minute window cannot match that, so a midnight-exact row is compared on its date, with
  // a day and a half of slack for the timezone the person logged it in.
  const DATE_ONLY_WINDOW_MS = 36 * 60 * 60 * 1000
  const isDateOnly = (ts: number) => ts % (24 * 60 * 60 * 1000) === 0
  const keep = items.filter((it) => {
    const t = Date.parse(it.sent_at)
    return !existing.some((row) => {
      if (norm(row.direction) !== norm(it.direction) || norm(row.subject) !== norm(it.subject)) return false
      const rt = Date.parse(row.sent_at)
      if (!Number.isFinite(t) || !Number.isFinite(rt)) return false
      return Math.abs(rt - t) <= (isDateOnly(rt) ? DATE_ONLY_WINDOW_MS : windowMs)
    })
  })
  return { keep, dropped: items.length - keep.length }
}
