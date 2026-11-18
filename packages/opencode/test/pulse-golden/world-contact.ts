/**
 * The contact (lead) route's fixed world (#189244). Invented lead, invented messages.
 *
 * Channel answers carry DISTINCT delays on purpose: `iris leads pulse` reads its channels
 * concurrently and lists them in the order they answer, so the delays fix that order — and are
 * deliberately not the order the channels are declared in, so a refactor that quietly
 * serialised them would fail here.
 */
import { USER_ID, ago } from "./world"

export const LEAD_ID = 7001

const lead = {
  id: LEAD_ID,
  name: "Dana Example",
  email: "dana@example.com",
  phone: "+15550100",
  status: "Active",
  company: "Example Co",
  contact_info: { emails: ["dana.alt@example.com"] },
}

const exec = (integration: string, action: string) => ({
  method: "POST",
  match: `/api/v1/users/${USER_ID}/integrations/execute-direct`,
  bodyMatch: `"integration":"${integration}","action":"${action}"`,
})

/** API answers every contact case shares — the lead, its score, its deal. */
function base(): unknown[] {
  return [
    { match: `^/api/v1/leads/${LEAD_ID}$`, regex: true, body: { data: lead } },
    {
      match: `/api/v1/leads/${LEAD_ID}/readiness`,
      body: {
        data: {
          score: 64,
          band: "at_risk",
          signals: {
            comms_freshness: { score: 40, last_outbound_at: ago(3), last_inbound_at: ago(6) },
            deal_health: { score: 70, checks: {} },
          },
          weights_applied: { comms_freshness: 0.4, deal_health: 0.6 },
          history: [
            { score: 58, created_at: ago(14) },
            { score: 61, created_at: ago(7) },
          ],
        },
      },
    },
    { match: `/api/v1/leads/${LEAD_ID}/tasks`, body: { data: [{ id: 1, title: "Send the revised quote", status: "pending", due_date: ago(-2) }] } },
    { match: `/api/v1/leads/${LEAD_ID}/activities`, body: { data: [{ id: 1, type: "note", content: "Call went well", created_at: ago(4) }] } },
    { match: `/api/v1/leads/${LEAD_ID}/requirements`, body: { data: [] } },
  ]
}

/** Every channel readable. */
export function contactRoutes(): unknown[] {
  return [
    ...base(),
    // health probes — specific paths first, the lead's own reads below them
    { ...exec("gmail", "get_labels"), body: { success: true, data: { labels: [{ id: "INBOX", name: "INBOX" }] } } },
    { match: "/api/calendar/events?days=1", body: { events: [] } },
    { match: "/api/imessage/search?handle=health-probe", body: { messages: [] } },
    { match: "/api/mail/search?from=test", body: { messages: [] } },
    { match: "/health", body: { ok: true } },

    {
      match: `/api/v1/leads/${LEAD_ID}/gmail-threads`,
      delay: 60,
      body: {
        data: [
          { latest_subject: "Quote v2", latest_from: "dana@example.com", last_message_at: ago(2), message_count: 3, sent_count: 1, thread_id: "t1" },
          { latest_subject: "Kickoff notes", latest_from: "me@example.org", last_message_at: ago(9), message_count: 2, sent_count: 2, thread_id: "t2" },
          { latest_subject: "Old thread", latest_from: "dana@example.com", last_message_at: ago(80), message_count: 1, sent_count: 0, thread_id: "t3" },
        ],
      },
    },
    {
      match: "/api/imessage/search?handle=%2B15550100",
      delay: 10,
      body: {
        messages: [
          { text: "See you Thursday", ts: ago(1), from_me: false },
          { text: "Sent the quote", ts: ago(2), from_me: true },
        ],
      },
    },
    {
      match: "/api/imessage/group-chats",
      delay: 5,
      body: { group_chats: [{ chat_identifier: "chat000111222", display_name: "Launch crew", recent_count: 2 }] },
    },
    { match: "/api/imessage/search?handle=chat000111222", delay: 30, body: { messages: [{ text: "Launch is Friday", ts: ago(3), from_me: false }] } },
    {
      match: "/api/mail/search?from=dana%40example.com",
      delay: 40,
      body: { messages: [{ subject: "Invoice question", date: ago(5), from: "dana@example.com" }] },
    },
    {
      match: "/api/mail/search?from=dana.alt%40example.com",
      delay: 45,
      body: {
        messages: [
          { subject: "Invoice question", date: ago(5), from: "dana.alt@example.com" },
          { subject: "Photos", date: ago(11), from: "dana.alt@example.com" },
        ],
      },
    },
    {
      ...exec("google-calendar", "get_events"),
      delay: 20,
      body: {
        success: true,
        data: {
          events: [
            { summary: "Dana Example / quote review", start: ago(4), location: "Zoom" },
            { summary: "Kickoff with dana@example.com", start: ago(-5), location: "" },
            { summary: "Dentist", start: ago(2) },
          ],
        },
      },
    },
  ]
}

/** The bridge refuses and Gmail answers 403: every channel blind, each with its own reason. */
export function contactRoutesBlind(): unknown[] {
  return [
    ...base(),
    { ...exec("gmail", "get_labels"), status: 403, body: { success: false, error: "ConnectedAccountExpired" } },
    { ...exec("google-calendar", "get_events"), body: { success: false, error: "calendar not connected" } },
    { match: "/health", status: 403, body: { error: "bad bridge token" } },
    { match: "/api/imessage/", status: 403, body: { error: "bad bridge token" } },
    { match: "/api/mail/", status: 403, body: { error: "bad bridge token" } },
    { match: "/api/calendar/", status: 403, body: { error: "bad bridge token" } },
    { match: `/api/v1/leads/${LEAD_ID}/gmail-threads`, status: 403, body: { message: "Gmail is not connected for this lead" } },
  ]
}
