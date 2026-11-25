import { describe, expect, test } from "bun:test"
import { assetGraph, manifestIcons } from "../../src/cli/cmd/edge/export"

// #194211 — an exported Genesis page must stay installable as its own app.
// Measured against production 2026-11-25: the export carried the manifest and the 180/192 icons
// only because the browser happened to fetch them; the 512 and maskable icons, named only inside
// the manifest, came back 404.
describe("edge export carries a page's app (#194211)", () => {
  const head = `
    <link rel="manifest" href="/p/playbook-library/manifest.webmanifest">
    <link rel="apple-touch-icon" sizes="180x180" href="/p/playbook-library/app-icon-180.png?v=ef518f43ba">
    <link rel="icon" href="/p/playbook-library/app-icon-192.png?v=ef518f43ba#x">`

  test("a versioned link is the file without its query", () => {
    const { required } = assetGraph({}, head)
    expect(required).toContain("/p/playbook-library/app-icon-180.png")
    expect(required).toContain("/p/playbook-library/app-icon-192.png")
  })

  test("the page's manifest is part of the graph (.webmanifest is 11 chars)", () => {
    expect(assetGraph({}, head).required).toContain("/p/playbook-library/manifest.webmanifest")
  })

  test("the icons only the manifest names are found, relative or absolute, query stripped", () => {
    const manifest = JSON.stringify({
      icons: [
        { src: "/p/playbook-library/app-icon-512.png?v=1", sizes: "512x512" },
        { src: "app-icon-512-maskable.png?v=1", sizes: "512x512", purpose: "maskable" },
        { src: "https://cdn.example.com/other.png" },
        { nope: true },
      ],
    })
    expect(manifestIcons(manifest, "/p/playbook-library/manifest.webmanifest")).toEqual([
      "/p/playbook-library/app-icon-512-maskable.png",
      "/p/playbook-library/app-icon-512.png",
    ])
  })

  test("a manifest that is not JSON names nothing, and does not throw", () => {
    expect(manifestIcons("<html>404</html>", "/x.webmanifest")).toEqual([])
  })

  test("unchanged: an unversioned asset and a protocol-relative URL", () => {
    const { required } = assetGraph({}, `<script src="/js/iris-sdk-1.js"></script><img src="//cdn.x/y.png">`)
    expect(required).toEqual(["/js/iris-sdk-1.js"])
  })
})
