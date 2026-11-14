/**
 * Is this email from a person, or from a machine? (#189480)
 *
 * Asked to answer job outreach, the inbox held ~120 job emails in 30 days and most were
 * LinkedIn / Jobot / Lensa alerts. The few real recruiters were buried, and nothing could
 * tell the two apart.
 *
 * THE ASYMMETRY THIS IS BUILT AROUND. Filing an alert as a person costs a glance. Filing a
 * recruiter as an alert means they are never answered. So the rules only say "alert" on
 * positive evidence of automation, and the domain alone is never that evidence: Jobot's
 * recruiters write from jobot.com, the same domain as Jobot's alerts; a LinkedIn InMail
 * comes from a linkedin.com address and is a person writing to you.
 */

export type SenderKind = "person" | "alert" | "unknown"
export type SenderVerdict = { kind: SenderKind; why: string }

/** Local parts that only machines use. Matched against the WHOLE local part. */
const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|alerts?|job-?alerts?|jobalerts?-noreply|jobs-?listings|jobs-?noreply|newsletters?|digest|mailer(-daemon)?|bounce[s]?|updates?|news)$/

/**
 * Domains where EVERY message is a feed, never a person. Kept short on purpose — a domain
 * belongs here only if no human there writes to candidates. Job boards that relay employer
 * replies (indeedemail.com) are not on it.
 */
const FEED_ONLY_DOMAINS = new Set(["lensa.com", "ziprecruiter.com", "glassdoor.com", "talent.com", "simplyhired.com", "careerbuilder.com"])

/** `jobs@` is a person-free mailbox only on a job board; at a company it can be a recruiter. */
const JOB_BOARD_DOMAINS = new Set(["indeed.com", "linkedin.com", "jobot.com", "dice.com", "monster.com", ...FEED_ONLY_DOMAINS])

/**
 * Role mailboxes that send marketing. NOT careers@ / recruiting@ / talent@ / hr@ — recruiting
 * teams write from those, and they are the mail this classifier exists to surface.
 */
const MARKETING_LOCAL =
  /^(info|email|editor|events?|rewards?|announce(ments)?|reply|store|shop|marketing|promo(tions)?|offers?|deals?|hello|team|support|help|service|contact|billing|receipts?|orders?|account|membership|community|feedback|survey|insider|digest)$/

/**
 * The first label of a bulk-mail sending subdomain: e.taxact.com, members.wayfair.com,
 * m.shopifyemail.com, mp1.tripadvisor.com, ss.email.nextdoor.com. A person at a company writes
 * from the company's own domain (jpatel@staffingco.com), not from a sending host.
 */
const BULK_SUBDOMAIN =
  /^(e|em|eml|email|emails|mail|mails|mailer|mailing|m|events|digital|mp\d*|news|newsletters?|info|marketing|mkt|members|ss|send|sender|go|t|click|alerts?|notifications?|notify|service|updates?|comms|engage|crm|promo|offers?|reply|bounce)$|marketing|^inside/

/** Subjects that are digests, not correspondence. */
const BULK_SUBJECT =
  /\b(\d+\+?\s+new\s+jobs?|new\s+jobs?\s+(for|in|near|matching)\b|jobs?\s+(for|matching)\s+you|job\s+alert|recommended\s+jobs?|jobs?\s+you\s+might\s+like|a\s+job\s+you\s+might\s+like|and\s+\d+\s+more\b|jobs?\s+near\s+you)/i

export function classifySender(m: { sender: string; senderName?: string; subject?: string }): SenderVerdict {
  const address = String(m.sender ?? "").trim().toLowerCase()
  const name = String(m.senderName ?? "").trim()
  const subject = String(m.subject ?? "")

  if (!address.includes("@")) return { kind: "unknown", why: "no sender address to judge" }
  const [local, domain] = address.split("@")
  // Root domain, so mail.jobot.com and jobot.com are one sender.
  const root = domain.split(".").slice(-2).join(".")

  // A person writing through a platform's relay. Checked FIRST: the relay address
  // (messages-noreply@linkedin.com) looks automated and the message is not.
  if (/\bvia linkedin$/i.test(name)) return { kind: "person", why: `a person writing through LinkedIn (${name})` }

  if (AUTOMATED_LOCAL.test(local) || local.includes("noreply") || local.includes("no-reply")) {
    return { kind: "alert", why: `automated sender (${local}@)` }
  }
  if (local.includes("+")) return { kind: "alert", why: `tagged bulk address (${local}@)` }
  if (MARKETING_LOCAL.test(local)) return { kind: "alert", why: `role mailbox that sends marketing (${local}@)` }
  const labels = domain.split(".")
  if (labels.length >= 3 && BULK_SUBDOMAIN.test(labels[0])) return { kind: "alert", why: `bulk-mail sending host (${domain})` }
  if (FEED_ONLY_DOMAINS.has(root)) return { kind: "alert", why: `${root} only sends job feeds` }
  if (local === "jobs" && JOB_BOARD_DOMAINS.has(root)) return { kind: "alert", why: `job-board feed (${address})` }
  if (BULK_SUBJECT.test(subject)) return { kind: "alert", why: "digest subject line" }

  return { kind: "person", why: name ? `written by ${name}` : "no sign of automation" }
}
