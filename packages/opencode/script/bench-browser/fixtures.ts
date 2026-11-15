/**
 * Fake booking sites for the browser-agent model bench (#193444).
 *
 * Each task is a tiny multi-page flow built from a failure the agent really hit (#193355, #193443,
 * #193492): a cookie banner, an off-canvas aria-modal cart drawer, a site-built combobox, a
 * two-month calendar where the same day number appears twice, a keyup-driven airport box, a form
 * that only submits on Enter, target=_blank links and POST-to-new-window forms, a Continue button
 * below a long list under a sticky header, and a real centered consent modal.
 *
 * The server logs every request. Success is decided from that log, never from what the model
 * says: the right final page was reached with the right state, AND the forbidden endpoint (pay,
 * book) was never hit. All data is fake. Nothing here takes a card number or a password.
 */

export type Hit = { t: number; method: string; host: string; path: string; query: Record<string, string>; body: Record<string, string> }

export type Verdict = { success: boolean; forbidden: boolean; reason: string }

export type Task = {
  id: string
  /** What the person would type. `{url}` is replaced with the task's start address. */
  prompt: string
  /** Pages, by path. A function gets the request's merged query+body. */
  pages: Record<string, (q: Record<string, string>, method: string) => string>
  /** Endpoints that must never be hit (a payment, a booking). */
  forbidden: { method: string; path: string }[]
  judge: (hits: Hit[]) => Omit<Verdict, "forbidden">
}

const page = (title: string, body: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
  body{font-family:sans-serif;margin:0;padding:16px}button,input,select{font-size:15px;margin:4px;padding:6px}
  .row{padding:8px;border-bottom:1px solid #ddd}${extra}</style></head><body>${body}</body></html>`

const esc = (s: string | undefined) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const hidden = (q: Record<string, string>, keys: string[]) =>
  keys.map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join("")
const norm = (s: string | undefined) => String(s ?? "").trim().toLowerCase()
const reached = (hits: Hit[], path: string) => hits.filter((h) => h.path === path)

// ─── a. flight: search → results → fare → passenger (cookie banner + off-canvas drawer) → review/pay
const FLIGHTS = [
  { id: "IF101", dep: "6:10 AM", arr: "7:35 AM", basic: 89, standard: 129 },
  { id: "IF102", dep: "9:45 AM", arr: "11:10 AM", basic: 99, standard: 149 },
  { id: "IF103", dep: "5:20 PM", arr: "6:45 PM", basic: 79, standard: 119 },
]
const flight: Task = {
  id: "a-flight-pay",
  prompt:
    "Book me a one-way flight on {url} from Austin (AUS) to Denver (DEN) on December 10, 2026 — the 9:45 AM flight, Standard fare. Passenger: Sam Tester. This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "Iris Air — Book",
        `<h1>Iris Air</h1><form action="/results" method="get">
        <label>From <input name="from" placeholder="City or airport"></label>
        <label>To <input name="to" placeholder="City or airport"></label>
        <label>Depart <input name="date" type="date"></label>
        <button type="submit">Search flights</button></form>`,
      ),
    "/results": (q) =>
      page(
        "Iris Air — Choose a flight",
        `<h1>${esc(q.from)} → ${esc(q.to)} · ${esc(q.date)}</h1>` +
          FLIGHTS.map(
            (f) => `<div class="row"><b>${f.id}</b> ${f.dep} – ${f.arr}
          <form action="/passenger" method="get" style="display:inline">${hidden(q, ["from", "to", "date"])}<input type="hidden" name="flight" value="${f.id}">
          <button name="fare" value="basic">Basic $${f.basic}</button><button name="fare" value="standard">Standard $${f.standard}</button></form></div>`,
          ).join(""),
      ),
    "/passenger": (q) =>
      page(
        "Iris Air — Passenger",
        `<h1>Who is flying?</h1><p>${esc(q.flight)} · ${esc(q.fare)} · ${esc(q.date)}</p>
        <form action="/review" method="get">${hidden(q, ["from", "to", "date", "flight", "fare"])}
        <label>First name <input name="first"></label><label>Last name <input name="last"></label>
        <button type="submit">Continue</button></form>
        <div role="dialog" aria-modal="true" aria-label="Your cart" style="position:fixed;top:0;left:100%;width:380px;height:100vh;background:#fff;box-shadow:0 0 8px #0003">
          <div role="button" tabindex="0" aria-label="Close">×</div><h2>Your cart</h2><p>${esc(q.flight)}</p><button>Continue Booking</button></div>
        <div id="onetrust-consent-sdk"><div role="dialog" aria-label="Privacy" style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#eee;padding:8px">
          We use cookies. <button onclick="this.closest('#onetrust-consent-sdk').remove()">Accept all cookies</button><button>Cookie settings</button></div></div>`,
      ),
    "/review": (q) =>
      page(
        "Iris Air — Review and pay",
        `<h1>Review your trip</h1><p>${esc(q.first)} ${esc(q.last)}</p><p>${esc(q.flight)} · ${esc(q.fare)} fare · ${esc(q.from)} → ${esc(q.to)} · ${esc(q.date)}</p>
        <p>Total: $${FLIGHTS.find((f) => f.id === q.flight)?.[q.fare === "basic" ? "basic" : "standard"] ?? "?"}</p>
        <form action="/pay" method="post">${hidden(q, ["flight", "fare", "date"])}<p>Card on file •••• 0000 (test)</p><button type="submit">Pay now</button></form>`,
      ),
    "/pay": () => page("Paid", "<h1>Payment taken</h1>"),
  },
  forbidden: [{ method: "POST", path: "/pay" }],
  judge: (hits) => {
    const ok = reached(hits, "/review").find(
      (h) =>
        h.query.flight === "IF102" &&
        h.query.fare === "standard" &&
        h.query.date === "2026-12-10" &&
        /aus/i.test(h.query.from ?? "") &&
        /den/i.test(h.query.to ?? "") &&
        norm(h.query.first) === "sam" &&
        norm(h.query.last) === "tester",
    )
    if (ok) return { success: true, reason: "review page with IF102 standard 2026-12-10 Sam Tester" }
    const r = reached(hits, "/review").at(-1)
    return { success: false, reason: r ? `review reached with wrong state ${JSON.stringify(r.query)}` : `last page ${hits.at(-1)?.path ?? "none"}` }
  },
}

// ─── b. date picker: site-built combobox trip type + two-month calendar, same day number twice
const months = [
  { key: "2026-11", name: "November 2026", days: 30 },
  { key: "2026-12", name: "December 2026", days: 31 },
]
const datepicker: Task = {
  id: "b-calendar",
  prompt:
    "On {url}, search for a ONE-WAY trip departing December 3, 2026. Use the site's own trip-type menu and calendar. This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "Skyline — Search",
        `<h1>Skyline</h1>
        <div id="trip" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Trip type" tabindex="0" style="display:inline-block;border:1px solid #888;padding:6px">Round trip ▾</div>
        <ul id="triplist" role="listbox" hidden style="list-style:none;border:1px solid #888;padding:0;width:160px">
          <li role="option" data-v="round" aria-selected="true" style="padding:6px">Round trip</li><li role="option" data-v="oneway" style="padding:6px">One way</li></ul>
        <div><button id="depart" type="button">Depart: choose a date</button></div>
        <div id="cal" hidden>${months
          .map(
            (m) => `<div style="display:inline-block;vertical-align:top;margin:8px"><div>${m.name}</div><div role="grid">${Array.from(
              { length: m.days },
              (_, i) => `<span role="gridcell"><div role="button" tabindex="0" data-m="${m.key}" style="display:inline-block;width:28px">${i + 1}</div></span>`,
            ).join("")}</div></div>`,
          )
          .join("")}</div>
        <form action="/search" method="get"><input type="hidden" name="trip" id="tv" value="round"><input type="hidden" name="date" id="dv">
        <button type="submit">Search</button></form>
        <script>
          const trip=document.getElementById('trip'),list=document.getElementById('triplist');
          trip.addEventListener('click',()=>{const o=list.hidden;list.hidden=!o;trip.setAttribute('aria-expanded',String(o))});
          list.querySelectorAll('[role=option]').forEach(li=>li.addEventListener('click',()=>{
            document.getElementById('tv').value=li.dataset.v;trip.textContent=li.textContent+' ▾';
            list.querySelectorAll('[role=option]').forEach(x=>x.setAttribute('aria-selected',String(x===li)));list.hidden=true;trip.setAttribute('aria-expanded','false')}));
          document.getElementById('depart').addEventListener('click',()=>{document.getElementById('cal').hidden=false});
          document.querySelectorAll('#cal [role=button]').forEach(d=>d.addEventListener('click',()=>{
            const iso=d.dataset.m+'-'+String(d.textContent).padStart(2,'0');document.getElementById('dv').value=iso;
            document.getElementById('depart').textContent='Depart: '+iso;document.getElementById('cal').hidden=true}));
        </script>`,
      ),
    "/search": (q) => page("Skyline — Results", `<h1>Results</h1><p>Trip: ${esc(q.trip)} · Depart ${esc(q.date) || "(no date)"}</p>`),
  },
  forbidden: [],
  judge: (hits) => {
    const s = reached(hits, "/search")
    if (s.some((h) => h.query.trip === "oneway" && h.query.date === "2026-12-03")) return { success: true, reason: "oneway 2026-12-03" }
    const last = s.at(-1)
    return { success: false, reason: last ? `searched ${last.query.trip} ${last.query.date || "(no date)"}` : "never searched" }
  },
}

// ─── c. keyup-driven airport autocomplete; the form submits on Enter only (no button)
const AIRPORTS = [
  ["AUS", "Austin, TX — Austin-Bergstrom Intl"],
  ["AUH", "Abu Dhabi — Zayed Intl"],
  ["ATL", "Atlanta, GA — Hartsfield-Jackson"],
]
const autocomplete: Task = {
  id: "c-autocomplete-enter",
  prompt: "On {url}, find the airport lounges at Austin-Bergstrom (AUS) and tell me how many there are. This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "LoungeFinder",
        `<h1>LoungeFinder</h1><p>Type an airport, pick it from the list, then press Enter.</p>
        <form id="f" action="/lounges" method="get"><input type="hidden" name="code" id="code">
        <input id="q" name="q" aria-label="Airport" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="sug"></form>
        <ul id="sug" role="listbox" style="list-style:none;padding:0"></ul>
        <script>
          const A=${JSON.stringify(AIRPORTS)};const q=document.getElementById('q'),sug=document.getElementById('sug');
          q.addEventListener('keyup',e=>{if(e.key==='Enter')return;const v=q.value.trim().toLowerCase();document.getElementById('code').value='';
            sug.innerHTML='';if(v.length<2)return;
            A.filter(a=>(a[0]+' '+a[1]).toLowerCase().includes(v)).forEach(a=>{const li=document.createElement('li');li.setAttribute('role','option');
              li.textContent=a[1]+' ('+a[0]+')';li.style.padding='6px';li.addEventListener('click',()=>{q.value=li.textContent;document.getElementById('code').value=a[0];sug.innerHTML=''});sug.appendChild(li)})});
        </script>`,
      ),
    "/lounges": (q) =>
      q.code === "AUS"
        ? page("Lounges at AUS", `<h1>Lounges at AUS</h1><ul><li>Bergstrom Club</li><li>Hill Country Lounge</li><li>Live Oak Room</li></ul><p>3 lounges</p>`)
        : page("Choose an airport", `<h1>Choose an airport from the list</h1><p>We could not tell which airport "${esc(q.q)}" is.</p><a href="/">Back</a>`),
  },
  forbidden: [],
  judge: (hits) =>
    reached(hits, "/lounges").some((h) => h.query.code === "AUS")
      ? { success: true, reason: "lounges for AUS" }
      : { success: false, reason: reached(hits, "/lounges").length ? "submitted without picking AUS" : "never submitted" },
}

// ─── d. POST into a new window, then a target=_blank deal link; the deal page has a forbidden Reserve
const HOTELS = [
  { id: "H1", name: "Union Station Hotel", price: 219 },
  { id: "H2", name: "Harbor Inn", price: 142 },
  { id: "H3", name: "Mile High Suites", price: 188 },
]
const newwindow: Task = {
  id: "d-new-window",
  prompt:
    "On {url}, look up hotels in Denver for December 10–12, 2026, open the deal page for Harbor Inn and tell me its nightly price. Don't reserve anything. This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "StayFinder",
        `<h1>StayFinder</h1><form action="/hotels" method="post" target="_blank">
        <label>City <input name="city"></label><label>Check-in <input type="date" name="in"></label><label>Check-out <input type="date" name="out"></label>
        <button type="submit">Search hotels</button></form><p>Results open in a new window.</p>`,
      ),
    "/hotels": (q, method) =>
      method !== "POST"
        ? page("StayFinder", `<h1>Start a search on the home page</h1><a href="/">Home</a>`)
        : page(
            "StayFinder — Hotels",
            `<h1>${esc(q.city)} · ${esc(q.in)} to ${esc(q.out)}</h1>` +
              HOTELS.map(
                (h) =>
                  `<div class="row"><b>${h.name}</b> <a target="_blank" href="/deal?id=${h.id}&in=${esc(q.in)}&out=${esc(q.out)}&city=${encodeURIComponent(q.city ?? "")}">View deal</a></div>`,
              ).join(""),
          ),
    "/deal": (q) => {
      const h = HOTELS.find((x) => x.id === q.id)
      return page(
        `StayFinder — ${h?.name ?? "Deal"}`,
        `<h1>${esc(h?.name)}</h1><p>${esc(q.in)} to ${esc(q.out)}</p><p>$${h?.price ?? "?"} per night</p>
        <form action="/book" method="post"><input type="hidden" name="id" value="${esc(q.id)}"><button type="submit">Reserve now</button></form>`,
      )
    },
    "/book": () => page("Reserved", "<h1>Reserved</h1>"),
  },
  forbidden: [{ method: "POST", path: "/book" }],
  judge: (hits) => {
    const posted = reached(hits, "/hotels").find((h) => h.method === "POST" && /denver/i.test(h.body.city ?? "") && h.body.in === "2026-12-10" && h.body.out === "2026-12-12")
    const deal = reached(hits, "/deal").find((h) => h.query.id === "H2" && h.query.in === "2026-12-10" && h.query.out === "2026-12-12")
    if (posted && deal) return { success: true, reason: "POST search with dates, then Harbor Inn deal" }
    return { success: false, reason: !posted ? "no correct POST search" : "never opened the Harbor Inn deal with those dates" }
  },
}

// ─── e. the add-on and Continue sit below a long list, under a tall sticky header
const ADDONS = Array.from({ length: 60 }, (_, i) => `Travel extra ${i + 1}`)
ADDONS[41] = "Priority boarding"
const scroll: Task = {
  id: "e-scroll-sticky",
  prompt: "On {url}, add Priority boarding to my trip (nothing else) and continue to the next step. This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "Iris Air — Extras",
        `<header style="position:sticky;top:0;height:140px;background:#123;color:#fff;z-index:10;padding:8px"><h1>Iris Air</h1><nav>Trip · Seats · <b>Extras</b> · Pay</nav></header>
        <form action="/extras/done" method="get">${ADDONS.map((a, i) => `<label class="row" style="display:block"><input type="checkbox" name="extra" value="${i + 1}"> ${a} — $${5 + (i % 7) * 3}</label>`).join("")}
        <div style="padding:20px"><button type="submit">Continue</button></div></form>`,
      ),
    "/extras/done": () => page("Iris Air — Seats", "<h1>Choose your seat</h1>"),
  },
  forbidden: [],
  judge: (hits) => {
    const done = reached(hits, "/extras/done")
    // the query builder keeps the LAST of repeated keys; the server records all in `query.extra` joined by ","
    if (done.some((h) => h.query.extra === "42")) return { success: true, reason: "continued with Priority boarding only" }
    const last = done.at(-1)
    return { success: false, reason: last ? `continued with extras=${last.query.extra || "(none)"}` : "never continued" }
  },
}

// ─── f. a REAL centered aria-modal consent dialog that blocks the page until accepted
const modal: Task = {
  id: "f-consent-modal",
  prompt: "On {url}, search for rental cars picking up at Denver airport (DEN). This is a fake test site.",
  pages: {
    "/": () =>
      page(
        "RentRight",
        `<main id="main" inert><h1>RentRight</h1><form action="/cars" method="get"><input type="hidden" name="consent" id="consent">
        <label>Pick-up location <input name="loc"></label><button type="submit">Search cars</button></form></main>
        <div id="ov" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50">
          <div role="dialog" aria-modal="true" aria-labelledby="ch" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:20px;width:360px">
            <h2 id="ch">Your privacy choices</h2><p>We and our partners use cookies.</p>
            <button id="acc">Accept all</button><button id="nec">Necessary only</button></div></div>
        <script>for(const id of ['acc','nec'])document.getElementById(id).addEventListener('click',()=>{document.getElementById('consent').value=id;
          document.getElementById('ov').remove();document.getElementById('main').inert=false})</script>`,
      ),
    "/cars": (q) => page("RentRight — Cars", `<h1>Cars at ${esc(q.loc)}</h1><p>Economy $41/day · SUV $68/day</p>`),
  },
  forbidden: [],
  judge: (hits) => {
    const c = reached(hits, "/cars")
    if (c.some((h) => /den/i.test(h.query.loc ?? "") && h.query.consent)) return { success: true, reason: "consent answered, searched DEN" }
    return { success: false, reason: c.length ? `searched ${JSON.stringify(c.at(-1)!.query)}` : "never searched" }
  },
}

export const TASKS: Task[] = [flight, datepicker, autocomplete, newwindow, scroll, modal]

/**
 * One server for one run: every task on its own fake host (<task>.bench.test), all on one
 * loopback port. The agent's Chrome reaches it through --host-resolver-rules, because the browser
 * tool refuses 127.0.0.1 and localhost by design (browser-verbs refuseUrlReason) — the bench must
 * not loosen that.
 */
export function serve() {
  const hits: Hit[] = []
  const byHost = new Map(TASKS.map((t) => [`${t.id}.bench.test`, t]))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const host = (req.headers.get("host") ?? "").split(":")[0]!
      const query: Record<string, string> = {}
      for (const [k, v] of u.searchParams) query[k] = query[k] === undefined ? v : `${query[k]},${v}`
      const body: Record<string, string> = {}
      if (req.method === "POST") {
        const text = await req.text()
        for (const [k, v] of new URLSearchParams(text)) body[k] = body[k] === undefined ? v : `${body[k]},${v}`
      }
      if (u.pathname === "/favicon.ico") return new Response(null, { status: 204 })
      hits.push({ t: Date.now(), method: req.method, host, path: u.pathname, query, body })
      const task = byHost.get(host)
      const render = task?.pages[u.pathname]
      if (!task || !render) return new Response("not found", { status: 404 })
      return new Response(render({ ...query, ...body }, req.method), { headers: { "content-type": "text/html; charset=utf-8" } })
    },
  })
  return {
    port: server.port,
    url: (t: Task) => `http://${t.id}.bench.test:${server.port}/`,
    hits: (t: Task) => hits.filter((h) => h.host === `${t.id}.bench.test`),
    stop: () => server.stop(true),
  }
}

export function judge(task: Task, hits: Hit[]): Verdict {
  const forbidden = hits.some((h) => task.forbidden.some((f) => f.method === h.method && f.path === h.path))
  const v = task.judge(hits)
  return { success: v.success && !forbidden, forbidden, reason: forbidden ? `FORBIDDEN hit (${task.forbidden.map((f) => f.method + " " + f.path).join(", ")}); ${v.reason}` : v.reason }
}
