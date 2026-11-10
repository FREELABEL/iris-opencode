import { describe, expect, test } from "bun:test"
import {
  applyQuery,
  approveDraft,
  channelGroup,
  dayLabel,
  groupByDay,
  isUnread,
  markDraft,
  markSeen,
  markUnread,
  newComposer,
  NO_QUERY,
  parseDrafts,
  parseSeen,
  pruneSeen,
  queryCounts,
  readableBody,
  rememberDrafts,
  replyChannelFor,
  sendBlock,
  sendConfirm,
  sendPayload,
  switchChannel,
  typeText,
  unreadCount,
  type Conversation,
  type ThreadAnswer,
} from "./iris-inbox-model"
import { MOVED_SUBVIEWS, panelScope, resolveSurfaceAlias } from "./iris-panel-nav"
import { DEFAULT_NAV_LAYOUT, mergeNavLayout, visibleNavItems } from "./iris-nav-layout"

// #192688 — the people inbox's rules. Shapes are what /iris/comms returned on 2026-11-06.
const conv = (o: Partial<Conversation>): Conversation => ({
  key: "lead:1",
  leadId: 1,
  name: "@alexrigby.7",
  channel: "instagram",
  channels: ["instagram"],
  lastAt: "2026-11-05T12:09:10.000Z",
  lastDirection: "inbound",
  preview: "what's the one thing that needs improvement?",
  lastInboundAt: "2026-11-05T12:09:10.000Z",
  inbound: 2,
  outbound: 1,
  needsReply: true,
  assigned: false,
  ...o,
})
const LIST = [
  conv({}),
  conv({ key: "lead:2", leadId: 2, name: "St. Elmo Brewing Co.", channel: "gmail", channels: ["gmail"], lastDirection: "outbound", needsReply: false, assigned: true, lastAt: "2026-11-04T19:48:13.000Z", lastInboundAt: "2026-11-04T18:46:54.000Z", subject: "Re: Live music night" }),
  conv({ key: "from:fan@example.com", leadId: undefined, name: "Test Fan", channel: "contact_form", channels: ["contact_form"], lastAt: "2026-11-05T22:52:03.000Z", lastInboundAt: "2026-11-05T22:52:03.000Z" }),
  conv({ key: "lead:4", leadId: 4, name: "ankit", lastDirection: "outbound", needsReply: false, lastAt: "2026-11-04T22:18:56.000Z", lastInboundAt: "2026-11-03T10:00:00.000Z", channels: ["instagram", "gmail_api"] }),
]

describe("unread is this computer's (#192688)", () => {
  test("a conversation they wrote in since you opened it here is unread", () => {
    expect(unreadCount(LIST, {})).toBe(4)
    const seen = markSeen({}, LIST[0])
    expect(seen).toEqual({ "lead:1": "2026-11-05T12:09:10.000Z" })
    expect(isUnread(LIST[0], seen)).toBe(false)
    // They write again: unread again.
    expect(isUnread({ ...LIST[0], lastInboundAt: "2026-11-06T09:00:00.000Z" }, seen)).toBe(true)
    expect(unreadCount(LIST, seen)).toBe(3)
  })
  test("only their messages make it unread; your own reply does not", () => {
    expect(isUnread(conv({ lastInboundAt: undefined, lastDirection: "outbound" }), {})).toBe(false)
  })
  test("mark unread, and a stored map that is not one", () => {
    expect(isUnread(LIST[0], markUnread(markSeen({}, LIST[0]), LIST[0]))).toBe(true)
    expect(parseSeen("{nope")).toEqual({})
    expect(parseSeen(JSON.stringify({ a: "x", b: 3 }))).toEqual({ a: "x" })
    expect(pruneSeen({ "lead:1": "x", "lead:gone": "y" }, LIST)).toEqual({ "lead:1": "x" })
  })
})

describe("filters, with counts that say what a click would show", () => {
  test("each filter", () => {
    const keys = (f: any, seen = {}) => applyQuery(LIST, { ...NO_QUERY, filter: f }, seen).map((c) => c.key)
    expect(keys("all")).toHaveLength(4)
    expect(keys("needsReply")).toEqual(["lead:1", "from:fan@example.com"])
    expect(keys("assigned")).toEqual(["lead:2"])
    expect(keys("unread", markSeen({}, LIST[0]))).toEqual(["lead:2", "from:fan@example.com", "lead:4"])
  })
  test("a channel matches any message in the conversation, and Gmail's four spellings are Email", () => {
    expect(channelGroup("gmail_api")).toBe("email")
    expect(channelGroup("apple_mail")).toBe("email")
    expect(channelGroup("contact_form")).toBe("form")
    expect(applyQuery(LIST, { ...NO_QUERY, channel: "email" }, {}).map((c) => c.key)).toEqual(["lead:2", "lead:4"])
  })
  test("search reads name, preview and subject", () => {
    expect(applyQuery(LIST, { ...NO_QUERY, search: "live music" }, {}).map((c) => c.key)).toEqual(["lead:2"])
  })
  test("filter counts are inside the chosen channel; channel counts inside the chosen filter", () => {
    const c = queryCounts(LIST, { ...NO_QUERY, filter: "needsReply", channel: "instagram" }, {})
    expect(c.filters).toEqual({ all: 2, unread: 2, needsReply: 1, assigned: 0 })
    expect(c.channels.instagram).toBe(1)
    expect(c.channels.form).toBe(1)
    expect(c.channels.email).toBe(0)
  })
})

describe("time", () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime()
  test("day groups read like Elon's timeline", () => {
    expect(dayLabel(new Date(2026, 10, 6, 9).toISOString(), now)).toBe("Today")
    expect(dayLabel(new Date(2026, 10, 5, 23).toISOString(), now)).toBe("Yesterday")
    expect(dayLabel("nope", now)).toBe("Earlier")
    const g = groupByDay([{ at: new Date(2026, 10, 6, 9).toISOString() }, { at: new Date(2026, 10, 6, 8).toISOString() }, { at: new Date(2026, 10, 5, 8).toISOString() }], (x) => x.at, now)
    expect(g.map((x) => [x.label, x.items.length])).toEqual([["Today", 2], ["Yesterday", 1]])
  })
  test("the scanner's tokens read as what happened", () => {
    expect(readableBody("[message_inline_share]")).toBe("Shared a post")
    expect(readableBody("[reaction_log_xmat]")).toBe("Reacted to a message")
    expect(readableBody("[whats_app_number_share_xma]")).toBe("Shared a WhatsApp number")
    expect(readableBody("[montage_share_xma]")).toBe("Shared a reel")
    expect(readableBody("hey [not a token]")).toBe("hey [not a token]")
  })
})

describe("draft → approve → send: nothing goes out without the person (#192688)", () => {
  const thread: Pick<ThreadAnswer, "replyTo" | "messages"> = {
    replyTo: { email: "info@stelmobrewing.com", sms: "+15125550100" },
    messages: [{ id: 1, channel: "gmail", direction: "inbound", to: [], subject: "Live music night", body: "hi", sentAt: "2026-11-04T18:46:54Z" }],
  }
  test("a new reply is addressed from the lead's card, with the thread's subject", () => {
    const c = newComposer("email", thread)
    expect(c).toEqual({ channel: "email", to: "info@stelmobrewing.com", subject: "Re: Live music night", text: "", origin: "person", approved: false })
    expect(newComposer("sms", thread).to).toBe("+15125550100")
    expect(newComposer("instagram", thread).to).toBeUndefined()
  })
  test("Send is blocked until there is text, an address and (for email) a subject", () => {
    const c = newComposer("email", thread)
    expect(sendBlock(c)).toContain("Write a reply")
    expect(sendBlock({ ...c, text: "hi" })).toBeUndefined()
    expect(sendBlock({ ...c, text: "hi", subject: " " })).toContain("subject")
    expect(sendBlock({ ...newComposer("instagram", thread), text: "hi" })).toContain("Instagram")
    expect(sendBlock({ ...newComposer("sms", thread), text: "x".repeat(1601) })).toContain("1,600")
  })
  test("an AI draft only reaches the reply box by approving it, and is marked as AI", () => {
    const c = approveDraft(newComposer("email", thread), { subject: "Re: Thursday", text: "Hi Jenni, Thursday works." })
    expect(c).toMatchObject({ text: "Hi Jenni, Thursday works.", subject: "Re: Thursday", origin: "ai", approved: true })
    expect(sendBlock(c)).toBeUndefined()
    // An unapproved AI text can't be sent (the engine refuses it too).
    expect(sendBlock({ ...c, approved: false })).toContain("Approve")
    // Editing keeps it an approved AI draft; clearing the box forgets it.
    expect(typeText(c, "Hi Jenni — Thursday works!")).toMatchObject({ origin: "ai", approved: true })
    expect(typeText(c, "")).toMatchObject({ origin: "person", approved: false })
    // Switching channel keeps the text and where it came from.
    expect(switchChannel(c, "sms", thread)).toMatchObject({ channel: "sms", to: "+15125550100", text: c.text, origin: "ai", approved: true })
  })
  test("the request says who wrote it, that it was approved, and carries the yes only from the dialog", () => {
    const c = approveDraft(newComposer("email", thread), { text: "Thursday works." })
    expect(sendPayload(c, 30466, 38)).toEqual({ leadId: 30466, channel: "email", text: "Thursday works.", to: "info@stelmobrewing.com", subject: "Re: Live music night", origin: "ai", approved: true, confirm: true, bloqId: 38 })
    expect(sendPayload({ ...newComposer("sms", thread), text: " on my way " }, 1)).toEqual({ leadId: 1, channel: "sms", text: "on my way", to: "+15125550100", origin: "person", approved: undefined, confirm: true })
  })
  test("the confirm names the person, the address and the channel, and that it can't be taken back", () => {
    const w = sendConfirm(approveDraft(newComposer("email", thread), { text: "x" }), "St. Elmo Brewing Co.")
    expect(w.title).toBe("Send this to St. Elmo Brewing Co.?")
    expect(w.lines[0]).toBe("It goes by email to info@stelmobrewing.com, exactly as written below. A sent message can't be taken back.")
    expect(w.lines).toContain("AI drafted it; you approved it.")
    expect(sendConfirm({ ...newComposer("instagram", thread), to: "alexrigby.7", text: "x" }, "@alexrigby.7").lines[0]).toContain("as an Instagram DM to @alexrigby.7")
  })
  test("which channel a reply goes out on", () => {
    expect(replyChannelFor("gmail_api")).toBe("email")
    expect(replyChannelFor("contact_form")).toBe("email")
    expect(replyChannelFor("instagram")).toBe("instagram")
    expect(replyChannelFor("whatsapp")).toBe("sms")
    expect(replyChannelFor("slack")).toBeUndefined()
  })
  test("drafts made here are kept per lead, newest first, and marked approved then sent", () => {
    let all = rememberDrafts({}, 7, [{ at: "2026-11-06T10:00:00Z", channel: "email", text: "a", state: "drafted" }])
    all = rememberDrafts(all, 7, [{ at: "2026-11-06T11:00:00Z", channel: "email", text: "b", state: "drafted" }])
    expect(all[7].map((d) => d.text)).toEqual(["b", "a"])
    all = markDraft(markDraft(all, 7, "a", "approved"), 7, "a", "sent")
    expect(all[7][1].state).toBe("sent")
    expect(parseDrafts("[1]")).toEqual({})
  })
})

describe("one Inbox tab; old ids land on it (#192688)", () => {
  test("Hive › Inbox is Inbox › Computers", () => {
    expect(MOVED_SUBVIEWS["hive/inbox"]).toEqual({ surface: "inbox", sub: "computers" })
    expect(resolveSurfaceAlias("hive", "inbox")).toEqual({ surface: "inbox", sub: "computers" })
    expect(resolveSurfaceAlias("hive", "machines")).toEqual({ surface: "hive", sub: "machines" })
    expect(resolveSurfaceAlias("outreach")).toEqual({ surface: "leads", sub: "review" })
  })
  test("the Inbox is account-wide, and shown by default after Leads — also for a saved layout that never had it", () => {
    expect(panelScope("inbox", "comms-inbox")).toBe("account")
    expect(visibleNavItems(mergeNavLayout(DEFAULT_NAV_LAYOUT, null))).toEqual(["atlas", "pages", "agents", "pulse", "leads", "inbox", "marketing", "browser"])
    const saved = { version: 2, order: ["leads", "marketing", "atlas", "pages"], hidden: [] }
    const merged = mergeNavLayout(DEFAULT_NAV_LAYOUT, saved)
    // Browser (#193062) now follows Marketing; what this test is about is Inbox after Leads.
    expect(visibleNavItems(merged).slice(0, 3)).toEqual(["leads", "inbox", "marketing"])
    // Hidden by the person stays hidden.
    expect(mergeNavLayout(DEFAULT_NAV_LAYOUT, { version: 2, order: ["atlas", "inbox"], hidden: ["inbox"] }).hidden).toContain("inbox")
  })
})
