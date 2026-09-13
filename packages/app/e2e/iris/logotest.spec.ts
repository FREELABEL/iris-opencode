import { test, expect } from "@playwright/test"
test.use({ channel: "chrome" })
test("can the app webview load a logo.dev image", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto("http://127.0.0.1:3411/")
  await page.waitForLoadState("domcontentloaded")
  const out = await page.evaluate(async () => {
    const tryOne = (src: string) =>
      new Promise<string>((res) => {
        const img = new Image()
        img.onload = () => res(`OK ${img.naturalWidth}x${img.naturalHeight}`)
        img.onerror = () => res("BLOCKED/ERROR")
        setTimeout(() => res("TIMEOUT"), 8000)
        img.src = src
      })
    const t = "pk_Z1oxHpjJTH--iMG6TPnzoA"
    return {
      domain: await tryOne(`https://img.logo.dev/slack.com?token=${t}&size=128&format=png`),
      byName: await tryOne(`https://img.logo.dev/name/social%20tiktok?token=${t}&size=128&format=png`),
      unknown: await tryOne(`https://img.logo.dev/thisdoesnotexist-zzz.com?token=${t}&size=128&format=png`),
    }
  })
  console.log("LOGO LOAD: " + JSON.stringify(out))
  expect(out.domain).toContain("OK")
})
