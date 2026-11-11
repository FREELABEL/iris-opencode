/** One browser step in words a person reads: "Opening vonlane.com", never the raw call. Typed text is not shown. */
export function browserStep(input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "")
    } catch {
      return u
    }
  }
  switch (str("action")) {
    case "open":
      return `Opening ${host(str("url"))}`
    case "read":
      return "Reading the page"
    case "find":
      return `Finding "${str("query").slice(0, 40)}"`
    case "window":
      return "Reading closer"
    case "elements":
      return "Looking at what's clickable"
    case "click":
      return "Clicking"
    case "type":
      return "Typing into a field"
    case "select":
      return `Choosing "${str("value").slice(0, 40)}"`
    case "scroll":
      return `Scrolling ${str("direction") || "down"}`
    case "screenshot":
      return "Looking at the page"
    case "close":
      return "Done with the page"
    default:
      return str("action")
  }
}


/** What a side_panel call did, in words: "Showed Browser", "Opened card #193186". */
export function panelStep(input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const name = (id: string) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : "")
  switch (str("action")) {
    case "show":
      return `Showed ${name(str("surface")) || "a product"}${str("sub") ? ` › ${name(str("sub"))}` : ""}`
    case "browse": {
      let host = str("url")
      try {
        host = new URL(host).hostname.replace(/^www\./, "")
      } catch {}
      return `Opened ${host} in the Browser`
    }
    case "artifact":
      return "Showed an artifact"
    case "card":
      return typeof input.item === "number" ? `Opened card #${input.item}` : "Opened a card"
    case "tab":
      return `Showed ${name(str("tab"))}`
    case "open":
      return "Opened the side panel"
    case "close":
      return "Closed the side panel"
    case "state":
      return "Checked what's on screen"
    default:
      return str("action")
  }
}
