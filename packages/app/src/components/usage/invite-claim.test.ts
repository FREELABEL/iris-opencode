import { beforeEach, describe, expect, test } from "bun:test"
import type { FetchJson } from "@/components/dialog-upgrade"
import { inviteSettled, pendingInviteCode, rememberInviteCode, settleInvite } from "@/utils/invite-code"
import {
  afterInviteClaim,
  autoClaimPendingInvite,
  claimInviteCode,
  inviteRowVisible,
  resetAutoClaimForTest,
  type InviteClaim,
} from "./invite-claim"
import type { UsagePlan } from "./usage-model"

type Call = { path: string; body: any }
/** The sidecar: /iris/invite/claim answers `claim`; the track pipe is recorded. */
function sidecar(claim: InviteClaim | "throw", calls: Call[] = []): FetchJson {
  return (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === "/iris/invite/claim") {
      if (claim === "throw") throw new Error("sidecar restarting")
      return claim
    }
    return {}
  }) as FetchJson
}
const SENT = {
  attributed: { ok: true, outcome: "attributed", message: "You're in — you'll both get +25M tokens after your first agent run." },
  self_invite: { ok: false, outcome: "self_invite", message: "That's your own code." },
  already_attributed: { ok: false, outcome: "already_attributed", message: "This account already used an invite." },
  too_old: { ok: false, outcome: "too_old", message: "Invite codes work in your first 14 days." },
  invalid_code: { ok: false, outcome: "invalid_code", message: "We couldn't find that code." },
  unreachable: { ok: false, outcome: "unreachable", message: "Couldn't reach IRIS to check that code. Try again in a moment." },
} satisfies Record<string, InviteClaim>

beforeEach(() => {
  localStorage.clear()
  resetAutoClaimForTest()
})

describe("claiming an invite once signed in (#194575)", () => {
  test("POSTs the code to /iris/invite/claim and shows the sidecar's sentence as it is", async () => {
    const calls: Call[] = []
    expect(await claimInviteCode(sidecar(SENT.too_old, calls), "friend42")).toEqual(SENT.too_old)
    expect(calls).toEqual([{ path: "/iris/invite/claim", body: { code: "friend42" } }])
  })

  test("a thrown fetch or an empty answer is still a sentence", async () => {
    expect(await claimInviteCode(sidecar("throw"), "friend42")).toEqual({
      ok: false,
      outcome: "unreachable",
      message: "Couldn't reach IRIS to check that code. Try again in a moment.",
    })
    expect((await claimInviteCode((async () => null) as FetchJson, "friend42")).message).toBe(
      "That code couldn't be checked right now. Try again later.",
    )
  })

  test("usage.invite_claimed fires on attributed, and only then", async () => {
    for (const [name, claim] of Object.entries(SENT)) {
      const calls: Call[] = []
      afterInviteClaim(sidecar(claim, calls), claim, "ring")
      await Promise.resolve()
      const tracked = calls.filter((c) => c.path === "/iris/onboarding/track").map((c) => c.body)
      expect([name, tracked]).toEqual([name, name === "attributed" ? [{ event: "usage.invite_claimed", label: "ring" }] : []])
    }
  })

  test("a final answer hides the row for good; a wrong code or a dropped network does not", () => {
    for (const [name, claim] of Object.entries(SENT)) {
      localStorage.clear()
      afterInviteClaim(sidecar(claim), claim, "ring")
      const final = ["attributed", "already_attributed", "too_old"].includes(name)
      expect([name, inviteSettled()]).toEqual([name, final])
    }
  })
})

describe("the popover's 'Have an invite code?' row (#194575)", () => {
  const explorer: UsagePlan = { measured: true, paid: false, progress: { level: { key: "explorer", label: "Explorer" }, nextLevel: null, checklist: [], streakWeeks: null } }

  test("shows while the account is at the first level", () => {
    expect(inviteRowVisible(explorer, false)).toBe(true)
  })

  test("hidden once a claim had a final answer on this machine", () => {
    expect(inviteRowVisible(explorer, true)).toBe(false)
  })

  test("hidden past the first level, with no level, unmeasured, or uncapped", () => {
    expect(inviteRowVisible({ ...explorer, progress: { ...explorer.progress!, level: { key: "builder", label: "Builder" } } }, false)).toBe(false)
    expect(inviteRowVisible({ ...explorer, progress: null }, false)).toBe(false)
    expect(inviteRowVisible({ ...explorer, measured: false }, false)).toBe(false)
    expect(inviteRowVisible({ ...explorer, uncapped: true }, false)).toBe(false)
    expect(inviteRowVisible(undefined, false)).toBe(false)
  })
})

describe("a remembered link, opened after sign-in, is claimed once (#194575)", () => {
  test("signed in: claimed, the code forgotten, and the answer handed back for a toast", async () => {
    rememberInviteCode("Friend42")
    const calls: Call[] = []
    expect(await autoClaimPendingInvite(sidecar(SENT.attributed, calls), true)).toEqual(SENT.attributed)
    expect(calls[0]).toEqual({ path: "/iris/invite/claim", body: { code: "friend42" } })
    expect(pendingInviteCode()).toBeNull()
    expect(inviteSettled()).toBe(true)
  })

  test("signed out: left for sign-in to send as invite_code", async () => {
    rememberInviteCode("friend42")
    const calls: Call[] = []
    expect(await autoClaimPendingInvite(sidecar(SENT.attributed, calls), false)).toBeNull()
    expect(calls).toEqual([])
    expect(pendingInviteCode()).toBe("friend42")
  })

  test("once per code per run, however often the auth poll fires", async () => {
    rememberInviteCode("friend42")
    const calls: Call[] = []
    const f = sidecar(SENT.unreachable, calls)
    expect(await autoClaimPendingInvite(f, true)).toBeNull()
    expect(await autoClaimPendingInvite(f, true)).toBeNull()
    expect(calls.filter((c) => c.path === "/iris/invite/claim")).toHaveLength(1)
    // Not the code's fault: kept for the next launch, and nothing said.
    expect(pendingInviteCode()).toBe("friend42")
  })

  test("a refusal is said, and the code is not tried again", async () => {
    rememberInviteCode("friend42")
    expect(await autoClaimPendingInvite(sidecar(SENT.self_invite), true)).toEqual(SENT.self_invite)
    expect(pendingInviteCode()).toBeNull()
    expect(inviteSettled()).toBe(false)
  })

  test("a remembered value that can't be a code is dropped without a call", async () => {
    rememberInviteCode("a_b")
    const calls: Call[] = []
    expect(await autoClaimPendingInvite(sidecar(SENT.attributed, calls), true)).toBeNull()
    expect(calls).toEqual([])
    expect(pendingInviteCode()).toBeNull()
  })

  test("already settled stays settled", async () => {
    settleInvite()
    expect(inviteRowVisible({ measured: true, progress: { level: { key: "explorer", label: "Explorer" }, nextLevel: null, checklist: [], streakWeeks: null } }, inviteSettled())).toBe(false)
  })
})
