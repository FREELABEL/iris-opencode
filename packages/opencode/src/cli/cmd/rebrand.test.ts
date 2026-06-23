import { test, expect } from "bun:test"
import { applyProfile, deriveSourceProfile, sourceNeedles, rebrandJsonContent, isAssetUrl, type BrandProfile } from "./rebrand"

// A Moody-style source (PII in MapSection/ContactSection + one non-structural echo).
const moodyLike = () => ({
  seo_title: "Moody Beauty — Lashes",
  theme: { branding: { name: "Moody Beauty", primaryColor: "#6B4226", logoUrl: "https://cdn.heyiris.io/cloud-files/1_mb-logo.png" } },
  components: [
    { type: "SiteNavigation", props: { logo: { text: "MOODY BEAUTY", imageUrl: "https://cdn.heyiris.io/cloud-files/1_mb-logo.png" }, ctaButton: { text: "Book with Lisa", url: "https://www.vagaro.com/moodybeauty" } } },
    { type: "Hero", props: { title: "EFFORTLESS BEAUTY", backgroundImage: "https://images.unsplash.com/photo-1.jpg", primaryButtonUrl: "https://www.vagaro.com/moodybeauty" } },
    { type: "MapSection", props: { locations: [{ name: "Moody Beauty Studio", phone: "(512) 953-7902", email: "moodybeauty.atx@gmail.com", address: ["4012 Marathon Boulevard", "Austin, TX 78756"] }] } },
    { type: "ContactSection", props: { contactInfo: [{ label: "Phone", value: "(512) 953-7902", link: "tel:5129537902" }, { label: "Email", value: "moodybeauty.atx@gmail.com" }] } },
    { type: "InstagramFeed", props: { instagram: "moodybeauty.atx" } },
    { type: "SiteFooter", props: { brandName: "Moody Beauty", logo: { tagline: "Lash artistry by Lisa Martinez · Austin" }, columns: [{ links: [{ label: "Call us: (512) 953-7902" }] }] } },
  ],
})

// A Dent-Society-style source (PII in Hero secondary button + footer columns).
const dentLike = () => ({
  theme: { branding: { name: "Dent Society", primaryColor: "#FF192C" } },
  components: [
    { type: "Hero", props: { title: "HAIL REPAIR", secondaryButtonText: "(214) 919-2237", secondaryButtonUrl: "tel:2149192237" } },
    { type: "SiteFooter", props: { brandName: "Dent Society", columns: [{ links: [{ label: "sales@dentsociety.com", href: "mailto:sales@dentsociety.com" }] }] } },
  ],
})

const TARGET: BrandProfile = {
  name: "Monarch Beauty", tagline: "Lash artistry — Austin", bookingUrl: "https://www.vagaro.com/monarchbeauty",
  colors: { primary: "#7C3AED" }, social: { instagram: "monarchbeauty.atx" },
  contact: { phone: "(737) 555-0188", email: "hello@monarchbeauty.co", address: { street: "98 San Jacinto Blvd", city: "Austin", state: "TX", zip: "78701" } },
}

test("isAssetUrl distinguishes template images from links", () => {
  expect(isAssetUrl("https://cdn.heyiris.io/x.png")).toBe(true)
  expect(isAssetUrl("https://images.unsplash.com/y.jpg")).toBe(true)
  expect(isAssetUrl("https://www.vagaro.com/moodybeauty")).toBe(false)
})

test("derives source identity", () => {
  const sp = deriveSourceProfile(moodyLike())
  expect(sp.name).toBe("Moody Beauty")
  expect(sp.contact?.phone).toBe("(512) 953-7902")
})

test("rebrand swaps name, applies target contact/colors, preserves template images", () => {
  const { json } = rebrandJsonContent(moodyLike(), TARGET)
  const s = JSON.stringify(json)
  expect(s).not.toContain("Moody")
  expect(s).not.toContain("Lisa")
  expect(json.theme.branding.name).toBe("Monarch Beauty")
  expect(json.components[0].props.logo.imageUrl).toBe("") // logo wordmark cleared -> text shows
  expect(json.components[2].props.locations[0].phone).toBe("(737) 555-0188")
  expect(json.components[3].props.contactInfo[1].value).toBe("hello@monarchbeauty.co")
  expect(s).toContain("images.unsplash.com/photo-1.jpg")
  // founder name stripped from CTA + tagline
  expect(json.components[0].props.ctaButton.text).not.toContain("Lisa")
})

test("blanks structural PII when the target supplies none", () => {
  const bare: BrandProfile = { name: "Bare Co", colors: { primary: "#111" } }
  const { json } = rebrandJsonContent(moodyLike(), bare)
  expect(json.components[2].props.locations[0].phone).toBe("")
  expect(json.components[3].props.contactInfo[0].value).toBe("")
})

test("template-agnostic: sweeps phone/email out of Hero buttons + footer columns (Dent shape)", () => {
  const { json } = rebrandJsonContent(dentLike(), TARGET)
  const s = JSON.stringify(json)
  expect(s).not.toContain("214") // old phone gone
  expect(s).not.toContain("dentsociety") // old email/name gone
  expect(json.components[0].props.secondaryButtonText).toBe("(737) 555-0188")
  expect(json.components[0].props.secondaryButtonUrl).toBe("tel:7375550188")
})

test("GATE: catches a source phone that survives in a non-structural field (no target phone)", () => {
  // target without phone -> structural phone blanked, but a footer-column echo would survive
  // were it not swept; the gate must still needle on the source phone everywhere.
  const src = moodyLike()
  const needles = sourceNeedles(src, deriveSourceProfile(src))
  expect(needles).toContain("(512) 953-7902")
  expect(needles.some((n) => n.includes("78756"))).toBe(true)
})
