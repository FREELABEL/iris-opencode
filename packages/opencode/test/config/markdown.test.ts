import { expect, test } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"

const template = `This is a @valid/path/to/a/file and it should also match at
the beginning of a line:

@another-valid/path/to/a/file

but this is not:

   - Adds a "Co-authored-by:" footer which clarifies which AI agent
     helped create this commit, using an appropriate \`noreply@...\`
     or \`noreply@anthropic.com\` email address.

We also need to deal with files followed by @commas, ones
with @file-extensions.md, even @multiple.extensions.bak,
hidden directories like @.config/ or files like @.bashrc
and ones at the end of a sentence like @foo.md.

Also shouldn't forget @/absolute/paths.txt with and @/without/extensions,
as well as @~/home-files and @~/paths/under/home.txt.

If the reference is \`@quoted/in/backticks\` then it shouldn't match at all.`

const matches = ConfigMarkdown.files(template)

test("should extract exactly 12 file references", () => {
  expect(matches.length).toBe(12)
})

test("should extract valid/path/to/a/file", () => {
  expect(matches[0][1]).toBe("valid/path/to/a/file")
})

test("should extract another-valid/path/to/a/file", () => {
  expect(matches[1][1]).toBe("another-valid/path/to/a/file")
})

test("should extract paths ignoring comma after", () => {
  expect(matches[2][1]).toBe("commas")
})

test("should extract a path with a file extension and comma after", () => {
  expect(matches[3][1]).toBe("file-extensions.md")
})

test("should extract a path with multiple dots and comma after", () => {
  expect(matches[4][1]).toBe("multiple.extensions.bak")
})

test("should extract hidden directory", () => {
  expect(matches[5][1]).toBe(".config/")
})

test("should extract hidden file", () => {
  expect(matches[6][1]).toBe(".bashrc")
})

test("should extract a file ignoring period at end of sentence", () => {
  expect(matches[7][1]).toBe("foo.md")
})

test("should extract an absolute path with an extension", () => {
  expect(matches[8][1]).toBe("/absolute/paths.txt")
})

test("should extract an absolute path without an extension", () => {
  expect(matches[9][1]).toBe("/without/extensions")
})

test("should extract an absolute path in home directory", () => {
  expect(matches[10][1]).toBe("~/home-files")
})

test("should extract an absolute path under home directory", () => {
  expect(matches[11][1]).toBe("~/paths/under/home.txt")
})

test("should not match when preceded by backtick", () => {
  const backtickTest = "This `@should/not/match` should be ignored"
  const backtickMatches = ConfigMarkdown.files(backtickTest)
  expect(backtickMatches.length).toBe(0)
})

test("should not match email addresses", () => {
  const emailTest = "Contact user@example.com for help"
  const emailMatches = ConfigMarkdown.files(emailTest)
  expect(emailMatches.length).toBe(0)
})

// An unquoted colon in a value is what people write and what Claude Code / the IRIS app accept.
// It used to throw here — and one such playbook took down every playbook listing with it.
test("frontmatter with an unquoted colon in a value parses, like the IRIS app", async () => {
  const dir = await import("fs").then((fs) => fs.mkdtempSync(require("path").join(require("os").tmpdir(), "md-colon-")))
  const file = require("path").join(dir, "PLAYBOOK.md")
  await Bun.write(file, "---\nname: tiny\ndescription: Do the tiny thing: carefully\n---\n\nBody: stays.\n")
  const md = await ConfigMarkdown.parse(file)
  expect(md.data.name).toBe("tiny")
  expect(md.data.description).toBe("Do the tiny thing: carefully")
  expect(md.content).toContain("Body: stays.")
})

test("sanitize only touches unquoted top-level values that contain a colon", () => {
  const src = '---\nname: x\ntitle: "quoted: kept"\nlist:\n  - a: b\ndescription: plain: fixed\n---\nbody\n'
  const out = ConfigMarkdown.sanitize(src)
  expect(out).toContain('title: "quoted: kept"')
  expect(out).toContain("  - a: b")
  expect(out).toContain("description: |-\n  plain: fixed")
  expect(out.endsWith("---\nbody\n")).toBe(true)
})
