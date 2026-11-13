// Runs at the start of every page in the Browser pane (main frame only). #193441.
//
// A form that POSTs into a new window carries its data in the request body. The pane cannot give a
// new window the page's own request: a new window becomes a tab the app opens by ADDRESS, and an
// address has no body. Google Flights' "Continue to book" is exactly this — a POST of the booking
// (fields u, w) to /travel/clk/f with target=_blank — and arrived at Google as an empty GET: 404
// instead of the airline (#193439). So such a form submits in THIS tab, where its body survives.
// Back returns to the page it came from. A GET form or a link keeps opening a new tab: its address
// is the whole request.
;(() => {
  if (window.__irisKeepPost) return
  window.__irisKeepPost = true

  const SAME = new Set(["", "_self", "_parent", "_top"])
  const opensNewWindow = (target) => {
    const t = (target || "").trim()
    if (SAME.has(t.toLowerCase())) return false
    // A name that is an iframe on this page loads there, not in a new window.
    return !Array.from(document.querySelectorAll("iframe[name], frame[name]")).some((f) => f.name === t)
  }
  const targetOf = (form, submitter) => {
    if (submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget")) return submitter.getAttribute("formtarget")
    if (form.hasAttribute("target")) return form.getAttribute("target")
    const base = document.querySelector("base[target]")
    return base ? base.getAttribute("target") : ""
  }
  const methodOf = (form, submitter) =>
    ((submitter && submitter.hasAttribute && submitter.hasAttribute("formmethod") ? submitter.getAttribute("formmethod") : form.getAttribute("method")) || "get").toLowerCase()

  // Point the form (and its submit button) at this tab; give back a function that undoes it.
  const keepHere = (form, submitter) => {
    if (methodOf(form, submitter) !== "post" || !opensNewWindow(targetOf(form, submitter))) return () => {}
    const had = form.getAttribute("target")
    const subHad = submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget") ? submitter.getAttribute("formtarget") : null
    form.setAttribute("target", "_self")
    if (subHad !== null) submitter.setAttribute("formtarget", "_self")
    return () => {
      if (had === null) form.removeAttribute("target")
      else form.setAttribute("target", had)
      if (subHad !== null) submitter.setAttribute("formtarget", subHad)
    }
  }

  // A person or a script pressing submit: the target is read AFTER this event, so changing it here
  // counts. Last in line (bubble on window) so a page that cancels or rewrites the form goes first.
  window.addEventListener("submit", (e) => {
    if (e.defaultPrevented || !(e.target instanceof HTMLFormElement)) return
    const undo = keepHere(e.target, e.submitter)
    setTimeout(undo, 0)
  })

  // form.submit() fires no submit event (Google's path). The target is read synchronously inside it.
  const submit = HTMLFormElement.prototype.submit
  HTMLFormElement.prototype.submit = function () {
    const undo = keepHere(this, null)
    try {
      return submit.call(this)
    } finally {
      undo()
    }
  }
})()
