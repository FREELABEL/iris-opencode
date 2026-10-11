import { describe, expect, test } from "bun:test"
import {
  bindingsBlock,
  bindingsBytes,
  injectBindings,
  rowsFrom,
  stripBindings,
  toolResultValue,
  type Bindings,
} from "../../src/util/iris-bindings"

// #188930 ADR-01: a chat artifact gets the /p/ page data contract, byte for byte.

const ads: Bindings = {
  ads: {
    data: [
      { id: 1, name: "Parts" },
      { id: 2, name: "Machinery" },
    ],
    meta: { source: "test", rows: 2 },
  },
}

/** Run the page the way a frame would: the injected scripts, then the page's own, in order. */
function runPage(html: string, pageScript: string) {
  const json = html.match(/<script type="application\/json" id="iris-bindings">([\s\S]*?)<\/script>/)?.[1]
  const shim = html.match(/<script>(\(function\(\)\{var w=window[\s\S]*?)<\/script>/)?.[1]
  const window: any = {}
  const document = { getElementById: (id: string) => (id === "iris-bindings" && json ? { textContent: json } : null) }
  return new Function("window", "document", `${shim ?? ""};var iris=window.iris;return (function(){${pageScript}})()`)(
    window,
    document,
  )
}

describe("iris-bindings — the /p/ contract inside a chat frame", () => {
  test("a page written for /p/ reads its rows unchanged", () => {
    const page = `<html><head><title>x</title></head><body></body></html>`
    const out = injectBindings(page, ads)
    expect(runPage(out, "return iris.data.rows('ads').map(function(r){return r.name})")).toEqual(["Parts", "Machinery"])
    expect(runPage(out, "return [iris.data.has('ads'), iris.data.has('nope'), iris.data.names()]")).toEqual([
      true,
      false,
      ["ads"],
    ])
    expect(runPage(out, "return iris.data.meta('ads').rows")).toBe(2)
    expect(runPage(out, "return iris.data.rows('nope')")).toEqual([])
  })

  test("the block goes first in <head>, before any page script", () => {
    const out = injectBindings(`<html><head><script>window.x=iris.data.rows('ads')</script></head></html>`, ads)
    expect(out.indexOf('id="iris-bindings"')).toBeLessThan(out.indexOf("window.x="))
  })

  test("data cannot close the script element it sits in", () => {
    const evil: Bindings = {
      a: { data: [{ name: "</script><script>alert(1)</script><!--" }], meta: { source: "t", rows: 1 } },
    }
    const block = bindingsBlock(evil)
    // exactly the two script elements we opened, closed once each
    expect(block.match(/<\/script>/g)?.length).toBe(2)
    // and no raw < or > inside the JSON at all: '<!--' in script data changes how the HTML
    // tokenizer reads the rest of the element, even when '</script>' itself is escaped
    const json = block.match(/id="iris-bindings">([\s\S]*?)<\/script>/)![1]
    expect(/[<>]/.test(json)).toBe(false)
    expect(runPage(injectBindings("<head></head>", evil), "return iris.data.rows('a')[0].name")).toBe(
      "</script><script>alert(1)</script><!--",
    )
  })

  test("an update replaces the block instead of stacking a second one", () => {
    const once = injectBindings("<html><head></head><body>hi</body></html>", ads)
    const twice = injectBindings(once, { ads: { data: [{ id: 9 }], meta: { source: "t", rows: 1 } } })
    expect(twice.match(/id="iris-bindings"/g)?.length).toBe(1)
    expect(runPage(twice, "return iris.data.rows('ads')[0].id")).toBe(9)
    expect(stripBindings(twice)).toBe("<html><head></head><body>hi</body></html>")
  })

  test("no bindings: the html is untouched (apart from an old block)", () => {
    expect(injectBindings("<p>plain</p>", undefined)).toBe("<p>plain</p>")
    expect(injectBindings("<p>plain</p>", {})).toBe("<p>plain</p>")
  })

  test("a document without <head> still gets the block before its body", () => {
    const out = injectBindings("<div id=app></div><script>document.x=1</script>", ads)
    expect(out.startsWith("<head>")).toBe(true)
    expect(runPage(out, "return iris.data.rows('ads').length")).toBe(2)
  })

  test("a page that ships its own iris.data keeps it", () => {
    const html = injectBindings("<head></head>", ads)
    const shim = html.match(/<script>(\(function\(\)\{var w=window[\s\S]*?)<\/script>/)![1]
    const window: any = { iris: { data: { mine: true } } }
    new Function("window", "document", shim)(window, { getElementById: () => null })
    expect(window.iris.data).toEqual({ mine: true })
  })

  test("iris.data.fetch fails loudly — there is no network in the frame", async () => {
    const out = injectBindings("<head></head>", ads)
    const p = runPage(out, "return iris.data.fetch('ads')") as Promise<unknown>
    await expect(p).rejects.toThrow(/no network/)
  })
})

describe("rowsFrom — any tool result becomes the rows a page iterates", () => {
  test("an array is the rows", () => expect(rowsFrom([1, 2])).toEqual([1, 2]))
  test("a JSON string is parsed", () => expect(rowsFrom('[{"a":1}]')).toEqual([{ a: 1 }]))
  test("a wrapped list is unwrapped one level", () => {
    expect(rowsFrom({ data: [{ a: 1 }], total: 1 })).toEqual([{ a: 1 }])
    expect(rowsFrom({ results: [1] })).toEqual([1])
  })
  test("any other object is one row", () => expect(rowsFrom({ a: 1 })).toEqual([{ a: 1 }]))
  test("plain text is one row", () => expect(rowsFrom("hello")).toEqual([{ text: "hello" }]))
  test("a path digs first", () => expect(rowsFrom({ x: { y: [{ z: 1 }] } }, "x.y")).toEqual([{ z: 1 }]))
  test("a path that misses is empty, not the whole value", () => expect(rowsFrom({ x: 1 }, "nope.deeper")).toEqual([]))
})

describe("toolResultValue — what a completed call produced", () => {
  test("JSON output wins", () =>
    expect(toolResultValue({ output: '{"rows":[1]}', metadata: { k: 1 } })).toEqual({ rows: [1] }))
  test("then metadata, if it carries more than display hints", () =>
    expect(toolResultValue({ output: "done", metadata: { title: "t", items: [1] } })).toEqual({
      title: "t",
      items: [1],
    }))
  test("display-only metadata does not count", () =>
    expect(toolResultValue({ output: "plain", metadata: { title: "t", truncated: false } })).toBe("plain"))
})

describe("size", () => {
  test("bytes are measured on what is written", () => {
    expect(bindingsBytes(ads)).toBe(new TextEncoder().encode(JSON.stringify(ads)).length)
  })
})
