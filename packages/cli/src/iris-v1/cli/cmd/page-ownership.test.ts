import { describe, expect, test } from "bun:test"
import { contentUpdatePayload, ownershipDrift } from "./page-base"

/**
 * #183667 — a content push must not carry ownership.
 *
 * `pages pull` writes owner_type/owner_id into the local file, `pages push` re-sent them, and
 * fl-api's PageController::update refuses on their mere PRESENCE:
 *
 *     if (($request->has('owner_type') || $request->has('owner_id'))
 *         && ! $this->actingUserIsTrusted($request)) { ...403 }
 *
 * `actingUserIsTrusted` resolves `config('genesis.trusted_user_ids', [193])`. 193 is the
 * operator account — the one every internal session runs as, and therefore the ONE account
 * that cannot reproduce this. Measured as user 1 against a real local fl-api: pull, then push
 * with no edits at all, 403.
 *
 * It also shuts the conflict-recovery path: `pages merge` legitimately restores owner_type and
 * owner_id from live when the local file lacks them, so the merged push is refused too.
 *
 * The fix is the one this codebase already reached one field over, for `requires_auth`
 * (#181984): the file may CARRY the field, push never SENDS it, and a divergence is reported
 * rather than silently synced in either direction. Ownership changes go through
 * `pages reassign`, which is explicit about what it is doing.
 */
describe("contentUpdatePayload — what a content push is allowed to carry", () => {
  const local = {
    slug: "probe",
    title: "Probe",
    seo_title: "SEO",
    seo_description: "desc",
    og_image: "https://example.test/a.png",
    visibility: "public",
    status: "published",
    requires_auth: true,
    owner_type: "bloq",
    owner_id: 1,
    _base: { version: 3, hash: "abc", pulled_at: "2026-09-04T00:00:00Z" },
    json_content: { components: [{ id: "hero-0", type: "TextBlock", props: {} }] },
  }

  test("it never sends owner_type or owner_id", () => {
    const payload = contentUpdatePayload(local, local.json_content)
    expect(payload).not.toHaveProperty("owner_type")
    expect(payload).not.toHaveProperty("owner_id")
  })

  test("it never sends requires_auth or status", () => {
    // Pinning the #181984 precedent alongside the new rule, so neither can regress silently.
    const payload = contentUpdatePayload(local, local.json_content)
    expect(payload).not.toHaveProperty("requires_auth")
    expect(payload).not.toHaveProperty("status")
  })

  test("it still sends the content and the presentation fields", () => {
    const payload = contentUpdatePayload(local, local.json_content)
    expect(payload.json_content).toEqual(local.json_content)
    expect(payload.title).toBe("Probe")
    expect(payload.seo_title).toBe("SEO")
    expect(payload.seo_description).toBe("desc")
    expect(payload.og_image).toBe("https://example.test/a.png")
    expect(payload.visibility).toBe("public")
  })

  test("it strips _base from the content it sends", () => {
    const withBase = { ...local.json_content, _base: { version: 3 } }
    const payload = contentUpdatePayload(local, withBase) as any
    expect(payload.json_content).not.toHaveProperty("_base")
  })

  test("the payload carries exactly the allowed keys and nothing else", () => {
    // An allow-list assertion, not a deny-list: a deny-list only catches the fields someone
    // thought to ban, and this bug arrived as a field nobody thought to ban.
    const payload = contentUpdatePayload(local, local.json_content)
    expect(Object.keys(payload).sort()).toEqual(
      ["json_content", "og_image", "seo_description", "seo_title", "title", "visibility"].sort(),
    )
  })

  test("absent optional fields are omitted rather than sent as undefined", () => {
    const bare = { json_content: { components: [] } }
    const payload = contentUpdatePayload(bare, bare.json_content)
    expect(Object.keys(payload)).toEqual(["json_content"])
  })
})

describe("ownershipDrift — report the divergence, sync neither way", () => {
  test("no drift when the local file carries no ownership", () => {
    expect(ownershipDrift({}, { owner_type: "bloq", owner_id: 1 })).toBeNull()
  })

  test("no drift when local and live agree", () => {
    expect(
      ownershipDrift({ owner_type: "bloq", owner_id: 1 }, { owner_type: "bloq", owner_id: 1 }),
    ).toBeNull()
  })

  test("a differing owner_id is drift", () => {
    expect(
      ownershipDrift({ owner_type: "bloq", owner_id: 2 }, { owner_type: "bloq", owner_id: 1 }),
    ).toEqual({ localType: "bloq", localId: 2, liveType: "bloq", liveId: 1 })
  })

  test("a differing owner_type is drift", () => {
    expect(
      ownershipDrift({ owner_type: "user", owner_id: 1 }, { owner_type: "bloq", owner_id: 1 }),
    ).toEqual({ localType: "user", localId: 1, liveType: "bloq", liveId: 1 })
  })

  test("a string owner_id equal to the live numeric one is not drift", () => {
    // A hand-edited or round-tripped file may carry "1". Reporting that as a divergence would
    // be a false alarm on every push, and a warning that cries wolf gets tuned out — which
    // costs the instrument, not the one incident.
    expect(
      ownershipDrift({ owner_type: "bloq", owner_id: "1" }, { owner_type: "bloq", owner_id: 1 }),
    ).toBeNull()
  })

  test("owner_type alone, with no live counterpart, is drift and reports null for live", () => {
    expect(ownershipDrift({ owner_type: "user" }, {})).toEqual({
      localType: "user",
      localId: null,
      liveType: null,
      liveId: null,
    })
  })
})
