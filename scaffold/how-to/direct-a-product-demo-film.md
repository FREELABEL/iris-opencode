---
category: Content & Media
level: intermediate
tags: [video, demo, launch, recording, motion, marketing]
duration_min: 45
---
# How to: Direct a product demo film — one story, five beats, a camera that knows where to look

## What this does

You end up with a 30–40 second, 1080p60 film of **your real product doing one real thing** — a
macOS desktop, a cursor that moves with intent, a camera that pushes in *before* the click and
holds on the result long enough to read it — and a CDN link you can post.

The problem it solves: screen recordings are easy to make and hard to watch. The zoom arrives after
the click. The camera drifts while the app thinks. The result flashes past before anyone reads it.
And a recording of your own machine puts your inbox, customers and file names one stray frame away
from a public ad. Smooth zooms and a pretty wallpaper don't fix any of that — **direction** does.

This recipe gives you the direction rules, the capture technique that makes them possible, and the
commands to render and ship the film with the `genesis-motion` playbook (IRIS's code-rendered video kit).

## The rules (decide these before you record anything)

Five beats, in order:

| Beat | What happens | Camera |
|---|---|---|
| **Setup** | The problem, in a headline, over the app at rest | Wide and still. **The headline is on screen at frame 0** — X and Instagram use frame 0 as the cover |
| **Action** | The one thing the user does (types the ask, clicks the button) | One push-in that **lands before** the click — the camera knows what's coming |
| **Watch** | The product works | One framing move, then **locked off**. Speed this up (3× or more, so it fits ~7 s); never cut it out |
| **Payoff** | The result appears | Push in so the result fills the frame, then **hold ≥ 1.5 s from the moment it's actually visible** — not from the click, not through a loading spinner |
| **Release** | Pull back, one line of copy, logo | Wide again, then your end card |

And six rules that hold across every beat:

1. **One camera move per beat.** One strong move beats five small ones. Constant micro-zooms read as nervous.
2. **Moves are physical** — at least 0.8 s, eased, never a whip. A critically damped spring (no overshoot) is the right curve.
3. **One action, one result.** If the film shows three features, it's three films.
4. **Show the real thing with believable data.** Never an empty state as the point. Seed a fictional company with enough data to look alive.
5. **Atmosphere is felt, not seen.** A colour grade that goes cool during setup and warm on the payoff works at ~10% — at 25% a dark UI goes murky. Soften only the frame's edges when pushed in, never the subject.
6. **The cursor serves the story.** It moves to things for a reason, becomes an I-beam over text and a hand over buttons, ripples on a click, and **fades out on the payoff** so nothing competes with the result.

## Step 1 — Write the story file

One beat line, one ask, one result. Writing it first is what makes the rest decidable.

```json
{
  "beat": "Monday. Twelve leads came in over the weekend. Which five are worth a call today?",
  "headline": "12 leads over the weekend.",
  "subhead": "Who gets a call today?",
  "url": "https://YOUR-APP-OR-GENESIS-PAGE",
  "action": "the exact thing the user types or clicks",
  "result": "the text that is on screen when it worked",
  "payoffLine": "Five calls. Ranked. Before coffee."
}
```

## Step 2 — Use a demo account, never your own

Record the product **signed in as a demo user with fictional data**, in a separate browser profile.
Fictional company, fictional people, `example.com` emails (that domain can never deliver mail), no
real customers, no real keys on screen.

If your product runs an AI agent that can use a shell or read files, lock it to the demo workspace
before you record: changing the home folder does **not** stop an agent from reading absolute paths,
and a curious agent will happily list a real Downloads folder on camera. Allow only the commands the
story needs.

## Step 3 — Record pixels and pointer separately

The polished look comes from **not** baking the cursor into the video. Record the screen without a
cursor, log the pointer and the events with timestamps, and draw the cursor and camera afterwards —
so the camera can move *before* a click it already knows is coming.

Chrome's own screencast does this at 2x. Save as `record.mjs` next to a `package.json` with
`"type": "module"`, then `npm i playwright@1.48.2`:

```js
import { chromium } from 'playwright'
import fs from 'node:fs'
const [url, out = 'take'] = process.argv.slice(2), W = 1440, H = 900
fs.mkdirSync(`${out}/frames`, { recursive: true })
// window-size: without it the capture loses the bottom ~87 px. force-device-scale-factor: without it frames are 1x.
const browser = await chromium.launch({ channel: 'chrome', args: [`--window-size=${W},${H}`, '--force-device-scale-factor=2'] })
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'dark' })
const page = await ctx.newPage()
await page.goto(url, { waitUntil: 'load' })          // not 'networkidle': apps with live connections never go idle
await page.waitForTimeout(3000)
const cdp = await ctx.newCDPSession(page), frames = [], events = {}, pointer = []
let T0 = null
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  T0 ??= metadata.timestamp
  const f = String(frames.length).padStart(5, '0') + '.jpg'
  fs.writeFileSync(`${out}/frames/${f}`, Buffer.from(data, 'base64'))
  frames.push({ f, t: +(metadata.timestamp - T0).toFixed(3) })
  await cdp.send('Page.screencastFrameAck', { sessionId })
})
// 30 fps at q85: 60 fps at 2x fills a disk fast during a long wait
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 2 })
while (T0 === null) { await page.mouse.move(1, 1); await page.mouse.move(2, 2); await page.waitForTimeout(30) }
const now = () => +(Date.now() / 1000 - T0).toFixed(3)
const mark = (k) => { events[k] = now() }
const cursorAt = (x, y) => page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y) || document.body).cursor, [x, y])
async function moveTo (x, y, dur = 0.8) { const s = Math.round(dur * 30), [x0, y0] = pointer.length ? [pointer.at(-1).x, pointer.at(-1).y] : [W * 0.8, H * 0.7]
  for (let i = 1; i <= s; i++) { const p = i / s, e = p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2, x1 = x0 + (x - x0) * e, y1 = y0 + (y - y0) * e
    await page.mouse.move(x1, y1); pointer.push({ t: now(), x: x1, y: y1, cursor: await cursorAt(x1, y1) }); await page.waitForTimeout(1000 / 30) } }

// ── your story's action, scripted. Example: click a field, type, press a button, wait for the result.
await page.waitForTimeout(2200)                                   // SETUP hold
const field = await page.getByRole('textbox').first().boundingBox()
mark('approach'); await moveTo(field.x + 120, field.y + field.height / 2)
mark('click'); await page.mouse.click(field.x + 120, field.y + field.height / 2)
mark('typeStart'); await page.keyboard.type('YOUR ASK', { delay: 55 }); mark('typeEnd')
mark('send'); await page.keyboard.press('Enter')
await page.getByText('YOUR RESULT TEXT').first().waitFor({ timeout: 120000 })
mark('shown')                                                     // the result is really on screen
await page.waitForTimeout(3500)                                   // PAYOFF hold room
mark('end')
await cdp.send('Page.stopScreencast'); await browser.close()
fs.writeFileSync(`${out}/take.json`, JSON.stringify({ frames, events, pointer }, null, 1))
console.log(frames.length, 'frames', events)
```

```bash
node record.mjs https://YOUR-APP-OR-GENESIS-PAGE take-01
```

You now have sharp 2880×1800 frames with no cursor in them, and a log saying exactly when each
beat happened and where the pointer was. Check a frame before going further:
`sips -g pixelWidth -g pixelHeight take-01/frames/00000.jpg` should say 2880 × 1800.

## Step 4 — Turn the log into a beat sheet, and check it

From `events`, write down each beat's start and end and its **one** camera move (start, end, and
what it frames). Then check it against the rules — this is the step that separates a directed film
from a recording:

- every move **ends at least 0.25 s before** the action it serves (`click`, `shown`);
- no beat has more than one move, and no move is shorter than 0.8 s;
- the payoff hold, measured from `shown`, is at least 1.5 s;
- the watch beat is ramped so it lasts about 7 s on screen;
- the headline is visible at t = 0.

If a check fails, fix the beat sheet or re-shoot. Don't render a film you already know is wrong.

## Step 5 — Render it on the desktop stage with genesis-motion

Install the motion kit, which renders a film from an HTML file where every frame is a pure function of time
(that's what makes motion blur and re-renders exact):

```bash
iris playbook install genesis-motion
iris playbook run genesis-motion "Weekend leads demo"
```

Its setup step installs the kit to `~/.iris/genesis-motion`. In your `film.html`:

- show the frame whose time is the latest one ≤ the film's take time (look it up in `take.json`'s `frames`);
- place the window on a wallpaper with a menu bar and dock, and the camera as `translate + scale`;
- run each camera move and the cursor as a critically damped spring (`K.springs` in the kit's `film-kit.js`; stiffness `(6/d)²`, damping `2·6/d` for a move of length `d`);
- map film time to take time piecewise, to speed up the watch beat.

Then render four stills first, look at them, and only then render the film:

```bash
node ~/.iris/genesis-motion/scripts/render.mjs film.html stills/ --stills 0,3.5,12,24
node ~/.iris/genesis-motion/scripts/render.mjs film.html film.mp4 --fps 60 --sub 2
```

**Check the stills for these before rendering:** the cover (still 0) has the headline; the payoff
still shows the finished result, not `Loading…`; no error messages are in frame; the result's text
is right (watch for shell-quoted values like `$40k` arriving as `k`).

## Step 6 — Ship it

```bash
iris cloud:upload film.mp4
curl -sI "<the CDN URL it printed>" | grep -iE "^HTTP|content-type"
```

The link is live when that prints `HTTP/2 200` and `content-type: video/mp4`. If you post it to X or
Instagram, set the cover explicitly to frame 0 — that's why the headline lives there.

## When it goes wrong

| What you see | Why | Fix |
|---|---|---|
| The zoom arrives after the click | The move was keyed to the click time, not before it | End every move ≥ 0.25 s before its action |
| The camera never stops moving | Several moves per beat, or a drifting "follow" during the wait | One move per beat; lock off during watch |
| The payoff is a loading spinner | The hold started at the click | Mark `shown` when the result is visible; hold from there |
| The wait feels endless | Real time on screen | Ramp it (3×–10×) so it fits ~7 s |
| Frames are 1440×813 or 1x | Missing launch flags | `--window-size=1440,900` and `--force-device-scale-factor=2` |
| The recorder hangs on start | Nothing repainted, so no first frame | Nudge the page (move the mouse) until a frame lands |
| The disk fills mid-take | 2x JPEGs at 60 fps through a long wait | 30 fps, q85, and a time cap on the wait |
| Your real files appear on screen | Recorded on your own account, or an unrestricted agent | Demo account, fictional data, agent locked to the demo workspace — re-shoot, and delete the take |
| The grade makes the UI muddy | Too strong on a dark interface | ~10% soft-light; it should be felt, not seen |

## Proof

`iris cloud:upload` printed a `cdn.heyiris.io` link, and `curl -sI` on it returns `HTTP/2 200` with
`content-type: video/mp4`. Open it: frame 0 is the headline over your app, the camera moves before
each action, and the result holds long enough to read.

## Related

- `genesis-motion` playbook — the code-rendered film kit this recipe renders with.
- Screen Studio popularised recording pixels and pointer separately and re-drawing the cursor and
  camera with springs; this recipe applies the same idea in code.
