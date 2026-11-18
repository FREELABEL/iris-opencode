/**
 * "Prove you're human" pages (Cloudflare, DataDome, PerimeterX, Akamai) in the Browser.
 *
 * IRIS never solves or slips past one: it is the site asking for a PERSON, and a bot that
 * answers gets the whole app blocked. So the agent stops, the gold bar asks the person to finish
 * the check in the pane, and the agent carries on when the page is the real one again. The same
 * wait as Allow: the engine re-asks every 1.5 s for up to 5 minutes (panel-page.ts).
 *
 * The page script reads a few signals and answers with them only: no page text leaves the page.
 */

/** The app's answer while a check is up. panel-page.ts waits on this text: keep them in step. */
export const HUMAN_CHECK_WAIT = "the site is checking for a human: the person needs to finish the check in the Browser"

export type HumanCheckSignals = {
  title: string
  heading: string
  /** Cloudflare's challenge page sets window._cf_chl_opt; only that page does. */
  cfChallenge: boolean
  /** A challenge form or captcha box that only block pages carry. */
  blockWidget: boolean
  /** Short page (a block page, not an article that mentions captchas) whose text asks for a human. */
  asksForHuman: boolean
}

const PHRASES =
  /^(just a moment|attention required|additional verification required|verify(ing)? you are (a )?human|are you a (human|robot)|please verify you are a human|checking (if the site connection is secure|your browser)|pardon our interruption|access to this page has been denied|one more step)/i

export function isHumanCheck(s: HumanCheckSignals | null | undefined): boolean {
  if (!s) return false
  return s.cfChallenge || s.blockWidget || PHRASES.test(s.title.trim()) || PHRASES.test(s.heading.trim()) || s.asksForHuman
}

/** Runs in the page. Answers HumanCheckSignals; reads, never changes, anything. */
export const HUMAN_CHECK_SCRIPT = `(() => {
  const q = (s) => !!document.querySelector(s);
  const h = document.querySelector("h1, h2");
  const text = (document.body && document.body.innerText) || "";
  return {
    title: document.title || "",
    heading: ((h && h.textContent) || "").slice(0, 120),
    cfChallenge: typeof window._cf_chl_opt === "object" && window._cf_chl_opt !== null,
    blockWidget: q('#challenge-form, #challenge-stage, #cf-challenge-running, iframe[src*="captcha-delivery.com"], #px-captcha, #sec-if-cpt-container'),
    asksForHuman: text.length < 1500 && /verify (that )?you are (a )?human|additional verification required|press (&|and) hold|complete the security check/i.test(text),
  };
})()`

/** Ask the pane. Any failure (no page yet, a page that won't answer) counts as "no check". */
export async function humanCheckShowing(evaluate: (script: string) => Promise<string>): Promise<boolean> {
  try {
    const env = JSON.parse(await evaluate(HUMAN_CHECK_SCRIPT)) as { ok?: boolean; value?: HumanCheckSignals }
    return env.ok === true && isHumanCheck(env.value)
  } catch {
    return false
  }
}
