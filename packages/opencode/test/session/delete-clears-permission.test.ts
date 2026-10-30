import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { PermissionNext } from "../../src/permission/next"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * #191785 — deleting a session must clear its pending permission requests, and its child
 * sessions' too. Before the fix Session.remove deleted storage and published Deleted but never
 * touched PermissionNext: the requests stayed listed, still accepted a reply, and the tools
 * waiting on them never finished.
 */
describe("deleting a session clears its pending permissions (#191785)", () => {
  test("DELETE /session/:id rejects the parent's and child's requests, keeps an unrelated one, and a late reply is 404", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        const other = await Session.create({})
        const base = { permission: "bash", patterns: ["ls"], metadata: {}, always: [], ruleset: [] }

        const replied: any[] = []
        const unsub = Bus.subscribe(PermissionNext.Event.Replied, (e) => {
          replied.push(e.properties)
        })

        const parentAsk = PermissionNext.ask({ ...base, id: "permission_del_parent", sessionID: parent.id }).catch(
          (e) => e,
        )
        const childAsk = PermissionNext.ask({ ...base, id: "permission_del_child", sessionID: child.id }).catch(
          (e) => e,
        )
        const otherAsk = PermissionNext.ask({ ...base, id: "permission_del_other", sessionID: other.id }).catch(
          (e) => e,
        )
        expect((await PermissionNext.list()).map((p) => p.id).sort()).toEqual([
          "permission_del_child",
          "permission_del_other",
          "permission_del_parent",
        ])

        const app = Server.App()
        const del = await app.request(`/session/${parent.id}`, { method: "DELETE", headers: { "x-opencode-directory": tmp.path } })
        expect(del.status).toBe(200)

        // Both the parent's and the child's requests are gone; the unrelated one is untouched.
        expect((await PermissionNext.list()).map((p) => p.id)).toEqual(["permission_del_other"])
        // The tools waiting on them are released.
        expect(await parentAsk).toBeInstanceOf(PermissionNext.RejectedError)
        expect(await childAsk).toBeInstanceOf(PermissionNext.RejectedError)
        // Same event a user reject publishes, so clients drop the prompts.
        expect(replied).toContainEqual({ sessionID: parent.id, requestID: "permission_del_parent", reply: "reject" })
        expect(replied).toContainEqual({ sessionID: child.id, requestID: "permission_del_child", reply: "reject" })
        expect(replied.some((r) => r.sessionID === other.id)).toBe(false)

        // A late reply to a deleted session's request is refused.
        const late = await app.request(`/permission/permission_del_parent/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({ reply: "once" }),
        })
        expect(late.status).toBe(404)

        unsub()
        await PermissionNext.reply({ requestID: "permission_del_other", reply: "once" })
        expect(await otherAsk).toBeUndefined()
        await Session.remove(other.id)
      },
    })
  }, 30000)
})
