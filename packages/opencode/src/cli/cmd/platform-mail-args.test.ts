import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { PlatformMailCommand, collectArgs, mailComposeOptions } from "./platform-mail"

/**
 * #191605: the flags as a person types them, through the real yargs options. Only parsing happens —
 * no handler runs, so nothing can be sent.
 */
describe("iris mail send / reply — flags", () => {
  test("several To (positional and --to), repeatable --cc (also comma lists), --bcc, repeatable --lead", () => {
    const argv = mailComposeOptions(yargs([]).exitProcess(false)).parseSync([
      "--to", "richard@v.example", "--to", "sean@v.example",
      "--cc", "junaid@v.example", "--cc", "robyn@v.example,terry@v.example",
      "--bcc", "me@v.example", "-b", "hi", "--lead", "15743", "--lead", "15744", "--from", "amayo@mypathwaysai.com",
    ])
    const a = collectArgs(argv, { positional: ["first@v.example"], replyTo: "<x@y>", all: true })
    expect(a.to).toEqual(["first@v.example", "richard@v.example", "sean@v.example"])
    expect(a.cc).toEqual(["junaid@v.example", "robyn@v.example", "terry@v.example"])
    expect(a.bcc).toEqual(["me@v.example"])
    expect(a.leads).toEqual([15743, 15744])
    expect(a.from).toBe("amayo@mypathwaysai.com")
    expect(a.replyTo).toBe("<x@y>")
    expect(a.all).toBe(true)
    expect(a.via).toBe("apple_mail")
    expect(a.dryRun).toBe(false)
  })

  test("the mail command registers send (several recipients) and reply", () => {
    const names: string[] = []
    const fake: any = new Proxy({}, { get: (_t, k) => (k === "command" ? (c: any) => (names.push(String(c.command)), fake) : () => fake) })
    ;(PlatformMailCommand as any).builder(fake)
    expect(names).toContain("send [recipients..]")
    expect(names).toContain("reply <id>")
  })
})
