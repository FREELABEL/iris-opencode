import { describe, expect, test } from "bun:test"
import { parseLaunchctl, programIsHome } from "./hive-local"
import { asText, openLine } from "./inbox-open"

describe("this computer's daemon", () => {
  test("reads pid and program from launchctl print", () => {
    const out = "gui/501/io.heyiris.daemon = {\n\tactive count = 1\n\tprogram = /tmp/iris-fresh/.iris/iris-daemon-wrapper.sh\n\tpid = 5322\n}"
    expect(parseLaunchctl(out)).toEqual({ pid: 5322, program: "/tmp/iris-fresh/.iris/iris-daemon-wrapper.sh" })
  })
  test("a loaded but stopped job has no pid", () => {
    expect(parseLaunchctl("\tprogram = /Users/a/.iris/w.sh\n\tstate = not running\n").pid).toBeNull()
  })
  // The 2026-10-17 case: launchd ran the daemon from a fresh-install test folder.
  test("only a program under ~/.iris counts as home", () => {
    expect(programIsHome("/Users/a/.iris/iris-daemon-wrapper.sh", "/Users/a")).toBe(true)
    expect(programIsHome("/tmp/iris-fresh/.iris/iris-daemon-wrapper.sh", "/Users/a")).toBe(false)
    expect(programIsHome("/Users/a/.iris-old/w.sh", "/Users/a")).toBe(false)
    expect(programIsHome(null, "/Users/a")).toBeNull()
  })
})

describe("opening an inbox message", () => {
  const a = JSON.stringify({ id: "a", type: "message", message: "hi", read: false })
  const b = JSON.stringify({ id: "b", type: "message", message: "secret", read: false, burn: true })

  test("marks the opened line read and leaves the others alone", () => {
    const r = openLine(`${a}\n${b}\n`, 1)!
    expect(r.row.message).toBe("hi")
    expect(JSON.parse(r.next.split("\n")[0]).read).toBe(true)
    expect(r.next.split("\n")[1]).toBe(b)
  })
  test("a burn message is removed after it is returned", () => {
    const r = openLine(`${a}\n${b}\n`, 2)!
    expect(r.row.message).toBe("secret")
    expect(r.next).not.toContain("secret")
    expect(r.next).toContain('"id":"a"')
  })
  // Same numbering as /iris/inbox: non-empty lines from 1, a bad line keeps its slot.
  test("numbers by non-empty manifest line, keeping an unparseable one in place", () => {
    const r = openLine(`${a}\n\nnot json\n${b}\n`, 3)!
    expect(r.row.id).toBe("b")
    expect(r.next).toContain("not json")
    expect(openLine(`${a}\nnot json\n`, 2)).toBeNull()
    expect(openLine(a, 5)).toBeNull()
  })
  test("text is shown; binaries and big files are not", () => {
    expect(asText(Buffer.from("hello"))).toBe("hello")
    expect(asText(Buffer.from([0x50, 0x00, 0x4b]))).toBeNull()
    expect(asText(Buffer.alloc(70 * 1024, 0x41))).toBeNull()
  })
})
