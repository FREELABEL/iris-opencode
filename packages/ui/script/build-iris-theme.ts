#!/usr/bin/env bun
/**
 * Writes src/theme/themes/iris.json — the IRIS house theme (#194375).
 *
 * The brand, in one place: warm paper + ink, ONE accent green. Edit the values below and re-run
 * `bun run generate:iris`; never hand-edit iris.json. `bun run check:contrast` must pass after.
 *
 *   light  paper ground, ink text, accent #059669 (UI: icons, focus, brand fills);
 *          #047857 where green is text or carries a white label (≥4.5:1).
 *   dark   warm ink ground, paper-tinted text, accent #34d399 (text and UI on ink);
 *          #047857 for fills that carry a white label.
 *
 * Hue ramps that are not the brand (red/orange/yellow/cyan/blue/purple/pink: states, syntax,
 * avatars) are OC-2's hand-tuned ramps, copied so the two themes agree on what "danger" looks like.
 */

import type { DesktopTheme } from "../src/theme/types"

const dir = import.meta.dir + "/../src/theme/themes"
const oc2 = (await Bun.file(dir + "/oc-2.json").json()) as DesktopTheme

const STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200] as const

/** Warm greys, 50 = lightest … 1200 = darkest. Light and dark use different ramps (dark lifts the mids). */
const greyLight = [
  "#fbfaf8", // 50   lightest paper (inputs, menus)
  "#f6f5f1", // 100  paper — panels, the chat
  "#efede8", // 200  ground — the window
  "#e8e6e1", // 300  raised / inset paper
  "#d8d5ce", // 400  hairlines on paper
  "#b0aca3", // 500
  "#85817a", // 600  faint text (disabled / placeholder only)
  "#5c5953", // 700  muted text
  "#3d3b37", // 800
  "#2e2d2a", // 900
  "#242321", // 1000
  "#191917", // 1100 ink — body text
  "#0f0f0e", // 1200
]
const greyDark = [
  "#fbf8f1",
  "#f0ebe0", // 100  paper text
  "#e2dccf",
  "#d2cbbc",
  "#bbb4a4", // 400
  "#a39c8d", // 500  muted text
  "#7e786b", // 600  faint text (disabled / placeholder only)
  "#5a5449", // 700
  "#3e3a32", // 800
  "#312d26", // 900
  "#27241e", // 1000 raised
  "#1e1b16", // 1100 panels, the chat
  "#16140f", // 1200 ground — the window (warm ink)
]
/** The one accent. 700 = #059669 is the brand swatch. */
const green = [
  "#ecfdf5",
  "#d1fae5",
  "#a7f3d0",
  "#6ee7b7",
  "#34d399",
  "#10b981",
  "#059669",
  "#047857",
  "#065f46",
  "#064e3b",
  "#053d2e",
  "#022c22",
]

const ramp = (prefix: string, values: string[]) =>
  Object.fromEntries(STEPS.map((step, i) => [`v2-${prefix}-${step}`, values[i]! + "ff"]))
const greyRamp = (values: string[]) => ({
  "v2-grey-50": values[0]! + "ff",
  ...ramp("grey", values.slice(1)),
})
const keepHues = (mode: "light" | "dark") =>
  Object.fromEntries(
    Object.entries(oc2[mode].v2Overrides ?? {}).filter(([key]) =>
      /^v2-(red|orange|yellow|cyan|blue|purple|pink)-\d+$/.test(key),
    ),
  )
const keepRest = (mode: "light" | "dark") =>
  Object.fromEntries(
    Object.entries(oc2[mode].v2Overrides ?? {}).filter(
      ([key]) => !/^v2-(grey|red|orange|yellow|green|cyan|blue|purple|pink)-\d+$/.test(key),
    ),
  )

const syntax = (dark: boolean) => ({
  "syntax-comment": "var(--v2-text-text-muted)",
  "syntax-keyword": dark ? "var(--v2-purple-400)" : "var(--v2-purple-800)",
  "syntax-string": dark ? "var(--v2-green-400)" : "var(--v2-green-800)",
  "syntax-primitive": dark ? "var(--v2-pink-400)" : "var(--v2-pink-800)",
  "syntax-property": dark ? "var(--v2-orange-400)" : "var(--v2-orange-800)",
  "syntax-type": dark ? "var(--v2-cyan-400)" : "var(--v2-cyan-900)",
  "syntax-constant": dark ? "var(--v2-yellow-400)" : "var(--v2-yellow-1000)",
  "syntax-critical": dark ? "var(--v2-red-400)" : "var(--v2-red-800)",
  "syntax-diff-add": "var(--v2-state-fg-success)",
  "syntax-diff-delete": "var(--v2-state-fg-danger)",
  "syntax-diff-unknown": dark ? "var(--v2-purple-400)" : "var(--v2-purple-700)",
  "text-diff-add-base": "var(--v2-state-fg-success)",
  "text-diff-delete-base": "var(--v2-state-fg-danger)",
  "markdown-link": dark ? "#34d399" : "#047857",
})

const light: DesktopTheme["light"] = {
  palette: {
    neutral: "#efede8",
    ink: "#141413",
    primary: "#059669",
    accent: "#6d4fc2",
    success: "#059669",
    warning: "#b7791f",
    error: "#c03a2b",
    info: "#3f6fa8",
    interactive: "#059669",
    diffAdd: "#a7f3d0",
    diffDelete: "#f2bbb7",
  },
  overrides: {
    "background-base": "#efede8",
    "background-weak": "#e8e6e1",
    "background-strong": "#f6f5f1",
    "background-stronger": "#fbfaf8",
    "surface-base": "#f6f5f1",
    "surface-base-hover": "#1414130a",
    "surface-raised-base": "#e8e6e1",
    "surface-raised-base-hover": "#e1dfd9",
    "surface-raised-strong": "#f6f5f1",
    "surface-raised-stronger": "#fbfaf8",
    "surface-raised-stronger-non-alpha": "#fbfaf8",
    "surface-inset-base": "#e8e6e1",
    "surface-float-base": "#191917",
    "surface-float-base-hover": "#242321",
    "surface-brand-base": "#047857",
    "surface-brand-hover": "#065f46",
    "text-on-brand-base": "#ffffff",
    "text-on-brand-strong": "#ffffff",
    "icon-on-brand-base": "#ffffff",
    "surface-interactive-base": "#047857",
    "surface-interactive-weak": "#e6f6ef",
    "text-on-interactive-base": "#ffffff",
    "text-interactive-base": "#047857",
    "icon-interactive-base": "#059669",
    "border-selected": "#059669",
    "border-interactive-base": "#059669",
    "border-interactive-focus": "#047857",
    "surface-success-base": "#e6f6ef",
    "icon-success-base": "#059669",
    "surface-critical-base": "#fbeeec",
    "text-strong": "#141413",
    "text-base": "#3d3b37",
    "text-weak": "#5c5953",
    "text-weaker": "#8d8982",
    "border-base": "#c9c5bd",
    "border-weak-base": "#d8d5ce",
    "border-weaker-base": "#e2dfd9",
    "icon-base": "#6b6862",
    "icon-weak-base": "#a8a49c",
    ...syntax(false),
  },
  v2Overrides: {
    ...keepRest("light"),
    ...greyRamp(greyLight),
    ...keepHues("light"),
    ...ramp("green", green),
    "v2-background-bg-base": "var(--v2-grey-100)",
    "v2-background-bg-deep": "var(--v2-grey-200)",
    "v2-background-bg-layer-01": "var(--v2-grey-300)",
    "v2-background-bg-layer-02": "var(--v2-grey-400)",
    "v2-background-bg-layer-03": "var(--v2-grey-500)",
    "v2-background-bg-layer-04": "var(--v2-grey-600)",
    "v2-background-bg-inverse": "var(--v2-grey-1100)",
    "v2-background-bg-contrast": "var(--v2-grey-1000)",
    "v2-background-bg-button-neutral": "var(--v2-grey-50)",
    "v2-background-bg-accent": "var(--v2-green-800)",
    "v2-text-text-base": "var(--v2-grey-1100)",
    "v2-text-text-muted": "var(--v2-grey-700)",
    "v2-text-text-faint": "var(--v2-grey-600)",
    "v2-text-text-accent": "var(--v2-green-800)",
    "v2-text-text-accent-hover": "var(--v2-green-900)",
    "v2-text-text-code-accent": "var(--v2-green-900)",
    "v2-icon-icon-base": "var(--v2-grey-800)",
    "v2-icon-icon-muted": "var(--v2-grey-600)",
    "v2-icon-icon-accent": "var(--v2-green-700)",
    "v2-icon-icon-accent-hover": "var(--v2-green-800)",
    "v2-border-border-focus": "var(--v2-green-700)",
    "v2-state-bg-success": "var(--v2-green-100)",
    "v2-state-fg-success": "var(--v2-green-800)",
    "v2-state-border-success": "var(--v2-green-300)",
    "v2-overlay-simple-tab-active-scrim": "#f6f5f100",
    "v2-overlay-simple-tab-hover-scrim": "#e8e6e100",
    "v2-overlay-simple-tab-scrim": "#f6f5f100",
    "v2-illustration-illustration-layer-01": "var(--v2-grey-300)",
    "v2-illustration-illustration-layer-02": "var(--v2-grey-400)",
    "v2-illustration-illustration-layer-03": "var(--v2-grey-500)",
  },
}

const dark: DesktopTheme["dark"] = {
  palette: {
    neutral: "#1e1b16",
    ink: "#f0ebe0",
    primary: "#34d399",
    accent: "#a99bf0",
    success: "#34d399",
    warning: "#e7b04a",
    error: "#f17471",
    info: "#86aee0",
    interactive: "#34d399",
    diffAdd: "#6ee7b7",
    diffDelete: "#f17471",
  },
  overrides: {
    "background-base": "#16140f",
    "background-weak": "#1e1b16",
    "background-strong": "#1a1813",
    "background-stronger": "#1e1b16",
    "surface-base": "#1e1b16",
    "surface-base-hover": "#f0ebe00d",
    "surface-raised-base": "#27241e",
    "surface-raised-base-hover": "#312d26",
    "surface-raised-strong": "#312d26",
    "surface-raised-stronger": "#312d26",
    "surface-raised-stronger-non-alpha": "#312d26",
    "surface-inset-base": "#1e1b16",
    "surface-float-base": "#27241e",
    "surface-float-base-hover": "#312d26",
    "surface-brand-base": "#34d399",
    "surface-brand-hover": "#6ee7b7",
    "text-on-brand-base": "#0b1f17",
    "text-on-brand-strong": "#0b1f17",
    "icon-on-brand-base": "#0b1f17",
    "surface-interactive-base": "#047857",
    "surface-interactive-weak": "#0e2a20",
    "text-on-interactive-base": "#ffffff",
    "text-interactive-base": "#34d399",
    "icon-interactive-base": "#34d399",
    "border-selected": "#34d399",
    "border-interactive-base": "#34d399",
    "border-interactive-focus": "#047857",
    "surface-success-base": "#0e2a20",
    "icon-success-base": "#34d399",
    "surface-critical-base": "#2b1712",
    "text-strong": "#f0ebe0",
    "text-base": "#d2cbbc",
    "text-weak": "#a8a192",
    "text-weaker": "#6e685c",
    "border-base": "#48433a",
    "border-weak-base": "#36322a",
    "border-weaker-base": "#2b2822",
    "icon-base": "#9c9586",
    "icon-weak-base": "#4d483f",
    ...syntax(true),
  },
  v2Overrides: {
    ...keepRest("dark"),
    ...greyRamp(greyDark),
    ...keepHues("dark"),
    ...ramp("green", green),
    "v2-background-bg-base": "var(--v2-grey-1100)",
    "v2-background-bg-deep": "var(--v2-grey-1200)",
    "v2-background-bg-layer-01": "var(--v2-grey-1000)",
    "v2-background-bg-layer-02": "var(--v2-grey-900)",
    "v2-background-bg-layer-03": "var(--v2-grey-800)",
    "v2-background-bg-layer-04": "var(--v2-grey-700)",
    "v2-background-bg-inverse": "var(--v2-grey-100)",
    "v2-background-bg-contrast": "var(--v2-grey-700)",
    "v2-background-bg-accent": "var(--v2-green-800)",
    "v2-text-text-base": "var(--v2-grey-100)",
    "v2-text-text-muted": "var(--v2-grey-500)",
    "v2-text-text-faint": "var(--v2-grey-600)",
    "v2-text-text-inverse": "var(--v2-grey-1100)",
    "v2-text-text-accent": "var(--v2-green-500)",
    "v2-text-text-accent-hover": "var(--v2-green-400)",
    "v2-text-text-code-accent": "var(--v2-green-400)",
    "v2-icon-icon-base": "var(--v2-grey-400)",
    "v2-icon-icon-muted": "var(--v2-grey-600)",
    "v2-icon-icon-inverse": "var(--v2-grey-1100)",
    "v2-icon-icon-accent": "var(--v2-green-500)",
    "v2-icon-icon-accent-hover": "var(--v2-green-400)",
    "v2-border-border-focus": "var(--v2-green-500)",
    "v2-state-bg-success": "var(--v2-green-1200)",
    "v2-state-fg-success": "var(--v2-green-500)",
    "v2-state-border-success": "var(--v2-green-900)",
    "v2-overlay-simple-tab-active-scrim": "#27241e00",
    "v2-overlay-simple-tab-hover-scrim": "#3e3a3200",
    "v2-overlay-simple-tab-scrim": "#16140f00",
    "v2-illustration-illustration-layer-01": "var(--v2-grey-900)",
    "v2-illustration-illustration-layer-02": "var(--v2-grey-800)",
    "v2-illustration-illustration-layer-03": "var(--v2-grey-700)",
  },
}

const theme: DesktopTheme = {
  $schema: "https://opencode.ai/desktop-theme.json",
  name: "IRIS",
  id: "iris",
  light,
  dark,
}

await Bun.write(dir + "/iris.json", JSON.stringify(theme, null, 2) + "\n")
console.log("Wrote iris.json —", Object.keys(light.v2Overrides!).length, "v2 tokens per mode")
