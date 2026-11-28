/**
 * Where the IRIS panel goes (#194511). In a window it sits beside the page, sized by the split
 * (iris-split). On a phone there is no room for two columns — the panel took its 360 px minimum of
 * a 393 px screen and left Home a 33 px sliver with words cut mid-letter — so there it is a
 * full-screen sheet over the page, and the page keeps its full width underneath.
 *
 * The phone query is the app breakpoint (Tailwind md, 768 px) that the titlebar, settings and the
 * chat page already use; this is not a second breakpoint system.
 */
export const IRIS_SHELL_PHONE_QUERY = "(max-width: 767px)"
export const IRIS_SHELL_PANEL_MIN = 360

export function irisShellPanelMax(row: number) {
  return Math.max(IRIS_SHELL_PANEL_MIN, Math.round(row * 0.8))
}

/** `share` is the page's share of the row (iris-split); `width` is the panel's, in px. */
export function irisShellPanelLayout(input: { phone: boolean; row: number; share: number }) {
  if (input.phone) return { overlay: true, width: input.row }
  return {
    overlay: false,
    width: Math.min(
      irisShellPanelMax(input.row),
      Math.max(IRIS_SHELL_PANEL_MIN, Math.round(input.row * (1 - input.share))),
    ),
  }
}
