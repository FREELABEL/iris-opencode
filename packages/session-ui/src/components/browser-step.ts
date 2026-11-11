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

