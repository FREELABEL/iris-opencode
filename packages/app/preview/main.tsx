import { render } from "solid-js/web"
import "@/index.css"
import { HomeFirstRun } from "@/pages/home/home-first-run"

/**
 * Renders the REAL HomeFirstRun with fixture answers for /iris/onboarding/*. `?step=` picks the
 * scenario: signin | connect | goal (an inbox already connected) | error | alex. Data is fictional.
 */
const step = new URLSearchParams(location.search).get("step") ?? "seen"
localStorage.removeItem("iris.onboarding.v1")

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
const alexLike = [
  { id: "a1", subject: "Heartbeat Report: Discover Media Platform — Completed", from: "Discover Curator (Heartbeat) <agent@freelabel.net>", snippet: "Run finished.", date: hoursAgo(0.2), automated: true, kind: "fyi" },
  { id: "a2", subject: "Your transaction at Apple Wallet requires a receipt", from: "Mercury <hello@mercury.com>", snippet: "Upload a receipt for $42.18.", date: hoursAgo(0.5), automated: true, kind: "action", unread: true },
  { id: "a3", subject: "Alex Mayo, you left something behind!", from: "TikTok Shop <shop@email.tiktok.com>", snippet: "Complete your order.", date: hoursAgo(0.4), automated: true, kind: "fyi" },
  { id: "a4", subject: "Unrecognized device signed in to your OpenRouter account", from: "OpenRouter <noreply@openrouter.ai>", snippet: "If this wasn't you, reset your password.", date: hoursAgo(0.7), automated: true, kind: "action", unread: true },
  ...Array.from({ length: 11 }, (_, i) => ({ id: `u${i}`, subject: `Heartbeat Report: Agent ${i + 1} — Completed`, from: `Agent ${i + 1} (Heartbeat) <agent@freelabel.net>`, snippet: "Run finished.", date: hoursAgo(i + 1), automated: true, kind: "fyi" })),
]
const threads = [
  { id: "1", subject: "Rescheduling Thursday's cleaning", from: "Maria Lopez <maria@example.com>", snippet: "Hi — something came up at work, is there anything open Friday morning instead? Thanks so much.", date: hoursAgo(0.6), unread: true, automated: false },
  { id: "2", subject: "Invoice #4471 — overdue", from: "Apex Dental Supply <billing@apexsupply.example>", snippet: "This is a reminder that invoice #4471 for $1,284.00 was due on September 30. Please remit at your earliest convenience.", date: hoursAgo(5), unread: true, automated: false },
  { id: "3", subject: "Question about my insurance claim", from: "Dev Patel <dev.p@example.com>", snippet: "My insurer says they never received the claim for my crown in August. Could you resend it?", date: hoursAgo(27), unread: false, automated: false },
  { id: "4", subject: "Weekly schedule", from: "Front Desk <frontdesk@brightsmile.example>", snippet: "Here's next week's schedule. Dr. Kim is out Wednesday afternoon.", date: hoursAgo(50), unread: false, automated: true },
  { id: "5", subject: "The new Gamma has arrived", from: "Gamma <team@gamma.app>", snippet: "See what's new", date: hoursAgo(8), unread: false, automated: true },
  { id: "6", subject: "Heartbeat Report: AIAI Holdings — Completed", from: "IRIS <no-reply@heyiris.io>", snippet: "Your scheduled heartbeat finished.", date: hoursAgo(3), unread: false, automated: true },
]
const json = (body: unknown, ms = 0) =>
  new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })), ms))

;(window as any).__previewFetch = (input: string, init?: RequestInit) => {
  const path = new URL(input).pathname
  const w = window as any
  if (path === "/iris/onboarding/state") {
    const pre = step !== "connect" && step !== "signin" ? "gmail" : undefined
    const conn: string[] = [pre, w.__conn].filter(Boolean)
    const mailType = conn.find((t) => t === "gmail" || t === "outlook")
    return json({ measured: true, signedIn: step !== "signin", mail: mailType ? { connected: true, type: mailType, account: "frontdesk@brightsmile.example" } : { connected: false }, connected: conn })
  }
  if (path === "/iris/integrations/connect") {
    const { type } = JSON.parse(String((init as any)?.body ?? "{}"))
    setTimeout(() => (w.__conn = type), 1500) // the browser round trip finishing
    return json({ measured: true, url: "https://accounts.google.com/o/oauth2/auth?…" })
  }
  if (path === "/iris/catalog") {
    const names: Array<[string, string, string]> = [["google-calendar", "Google Calendar", "google.com"], ["slack", "Slack", "slack.com"], ["stripe", "Stripe", "stripe.com"], ["quickbooks", "QuickBooks", "intuit.com"], ["google-drive", "Google Drive", "google.com"], ["notion", "Notion", "notion.so"], ["instagram", "Instagram", "instagram.com"], ["whatsapp", "WhatsApp", "whatsapp.com"], ["hubspot", "HubSpot", "hubspot.com"], ["dropbox", "Dropbox", "dropbox.com"], ["linkedin", "LinkedIn", "linkedin.com"], ["mailchimp", "Mailchimp", "mailchimp.com"], ["discord", "Discord", "discord.com"], ["github", "GitHub", "github.com"], ["trello", "Trello", "trello.com"], ["clio", "Clio", "clio.com"], ["canva", "Canva", "canva.com"], ["vagaro", "Vagaro", "vagaro.com"], ["openai", "OpenAI", "openai.com"], ["imessage", "iMessage", "apple.com"]]
    return json({ measured: true, catalog: names.map(([type, name, d]) => ({ type, name, mode: type === "openai" ? "key" : type === "imessage" ? "bridge" : "brokered", logoUrl: `https://img.logo.dev/${d}?token=pk_Z1oxHpjJTH--iMG6TPnzoA&size=64&format=png` })) })
  }
  if (path === "/iris/onboarding/mail") {
    if (step === "error") return json({ measured: false, reason: "the Gmail connection has expired — reconnect it", threads: [], waiting: [] })
    if (step === "alex") return json({ measured: true, account: "alex@freelabel.net", threads: alexLike, waiting: alexLike.filter((t) => t.kind === "action") }, 300)
    return json({ measured: true, account: "frontdesk@brightsmile.example", threads, waiting: threads.filter((t) => !t.automated).slice(0, 3) }, step === "reading" ? 600000 : 300)
  }
  if (path === "/iris/onboarding/capabilities") {
    // Mirrors CATALOG in packages/opencode/src/iris/onboarding-capabilities.ts (fixture copy).
    const R = "receipt|invoice|bill(?!ing)|payment (received|confirm)|paid|charge|transaction|statement|refund"
    const S = "sign[- ]?in|signed in|login|device|password|security|verify|verification|suspicious"
    const L = "quote|pricing|price|rates?|interested|inquir|enquir|book(ing)?|availability|proposal|partner|collab|hire|project|estimate|demo"
    const cat: Record<string, unknown[]> = {
      reply: [
        { id: "draft-replies", title: "Draft replies to people waiting on you", detail: "In your voice, ready for you to review and send", tool: "gmail · send_email (drafts)", evidence: { kinds: ["person"] }, source: "catalog", primary: true },
        { id: "lead-pulse", title: "Check what's happened with each person", detail: "Their recent activity across email, iMessage and meetings before you reply", tool: "iris leads pulse", evidence: { kinds: ["person"] }, source: "catalog" },
      ],
      admin: [
        { id: "bills-to-books", title: "Turn receipts and bills into your books", detail: "Match each charge to a receipt and record it", tool: "iris playbook run bills-to-books", evidence: { kinds: ["action", "fyi"], pattern: R }, source: "catalog", primary: true },
        { id: "security-alerts", title: "Check account and security alerts", detail: "Tell you which sign-ins and warnings need you, and what to do", tool: "gmail · read", evidence: { kinds: ["action"], pattern: S }, source: "catalog", primary: true },
      ],
      catchup: [
        { id: "summarise", title: "Summarise what you missed", detail: "Most important first, with what needs you", tool: "iris gmail unread", evidence: { kinds: ["person", "action", "fyi"] }, source: "catalog", primary: true },
        { id: "meeting-notes", title: "Pull notes and action items from your meetings", detail: "From meeting recaps in your inbox", tool: "iris atlas:meetings scan", evidence: { kinds: ["person", "fyi"], pattern: "meeting|call|notes|recap" }, source: "catalog" },
      ],
      leads: [
        { id: "follow-up-leads", title: "Follow up on people asking to buy, book or work together", detail: "Draft the follow-up that moves each one forward", tool: "iris leads pulse", evidence: { kinds: ["person"], pattern: L }, source: "catalog", primary: true },
        { id: "find-leads", title: "Find more leads like them", detail: "From public pages, Instagram and your inbox", tool: "iris reachr scrape", evidence: { kinds: ["person"], pattern: L }, source: "catalog" },
        { id: "intent:leads discover", title: "Also: leads discover", detail: "Suggested by IRIS for this goal", tool: "iris leads discover", evidence: { kinds: ["person", "action"] }, source: "intent" },
      ],
    }
    const body = JSON.parse(String((init as any)?.body ?? "{}"))
    // Same contract as capabilities(): the goal's own first, topped up to three from the nearest others.
    const own = (cat[body.id] ?? []) as any[]
    const rest = (["reply", "catchup", "admin", "leads"] as const).filter((k) => k !== body.id).flatMap((k) => (cat[k] as any[]).filter((c) => c.source === "catalog").map((c) => ({ ...c, primary: false })))
    return json({ measured: true, capabilities: [...own, ...rest].slice(0, 3) }, 400)
  }
  if (path === "/iris/onboarding/ground" && step === "alex") return json({ measured: false, reason: "fixture", choices: [] })
  if (path === "/iris/onboarding/ground")
    return json({
      measured: true,
      industry: "Dental practice",
      line: "You run a busy dental practice — three patients and a supplier are waiting on you this week.",
      choices: ["Reply to the patients waiting on me", "Chase the overdue supplier invoice", "Resend Dev's insurance claim"],
    }, 400)
  if (path === "/iris/onboarding/workspace") return json({ measured: true, path: "/Users/you/IRIS/dental-practice" }, 600000)
  return json({ ok: true })
}

render(
  () => (
    <div class="min-h-screen bg-v2-background-bg-base text-v2-text-text-base">
      <HomeFirstRun onStart={(d, p) => ((window as any).__started = { d, p })} onDone={() => {}} />
    </div>
  ),
  document.getElementById("root")!,
)
