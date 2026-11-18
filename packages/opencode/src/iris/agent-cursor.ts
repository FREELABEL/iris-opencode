/**
 * The agent's cursor (#193051): a teal arrow labelled IRIS that GLIDES to the element the agent
 * is about to act on and ripples when it clicks or types, so the person watching the Browser pane
 * (or the agent's visible Chrome) sees where it is working and that it is working.
 *
 * Purely visual. It lives in a closed shadow root on a fixed, pointer-events:none host at the top
 * z-index: the page's CSS can't restyle it and it never takes a click from the person or the page.
 * It fades out after a few seconds without a move. prefers-reduced-motion: it appears in place.
 *
 * Both scripts are page scripts like the rest of browser-driver's: they run through the same
 * evaluate() (the pane's, or CDP's) and return plain values.
 */

const STYLE = `
.c{position:fixed;left:0;top:0;transform:translate3d(var(--x),var(--y),0);transition:transform var(--d) cubic-bezier(.22,.61,.36,1),opacity .35s ease;will-change:transform;opacity:0}
.c.on{opacity:1}
.c svg{display:block;filter:drop-shadow(0 2px 5px rgba(0,0,0,.35))}
.c.press svg{transform:scale(.86);transition:transform .12s ease}
.tag{position:absolute;left:17px;top:17px;padding:1px 7px;border-radius:999px;background:#14b8a6;color:#fff;font:600 11px/16px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:.02em;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.r{position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #14b8a6;background:rgba(20,184,166,.18);transform:translate3d(var(--x),var(--y),0) scale(.25);opacity:.95;animation:r .6s cubic-bezier(.22,.61,.36,1) forwards}
@keyframes r{to{transform:translate3d(var(--x),var(--y),0) scale(1.7);opacity:0}}
@media (prefers-reduced-motion:reduce){.c{transition:opacity .2s ease}.r{animation-duration:.2s}}
`.replace(/\n/g, "")

const ARROW = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M3.5 2.5l14.5 7-6.2 1.7-3.1 5.8z" fill="#14b8a6" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`

/** Creates the cursor on first use (or again, if a page re-render dropped it). Shared prelude. */
const ENSURE = `
const W = window;
let s = W.__irisCursor;
if (!s || !s.host.isConnected) {
  const host = (s && s.host) || document.createElement('div');
  if (!s) {
    host.setAttribute('data-iris-cursor', '');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>${STYLE}</style><div class="c">${ARROW}<span class="tag">IRIS</span></div>';
    s = W.__irisCursor = { host, root, c: root.querySelector('.c'), x: innerWidth * 0.5, y: innerHeight * 0.62, fade: 0 };
    s.c.style.setProperty('--d', '0ms');
    s.c.style.setProperty('--x', s.x + 'px');
    s.c.style.setProperty('--y', s.y + 'px');
  }
  (document.body || document.documentElement).appendChild(host);
}
const keepAlive = () => { clearTimeout(s.fade); s.fade = setTimeout(() => s.c.classList.remove('on'), 4000); };
`

/**
 * Glide to the element holding this ref. Returns how long the glide takes (ms) so the caller
 * waits for it before acting, or -1 when the element isn't there (the act then reports that).
 */
export function cursorMoveScript(ref: number): string {
  return `(() => {
    const el = document.querySelector('[data-iris-ref="${Math.trunc(ref)}"]');
    if (!el) return -1;
    ${ENSURE}
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      r = el.getBoundingClientRect();
    }
    const x = Math.round(r.left + Math.min(r.width / 2, Math.max(12, r.width - 12)));
    const y = Math.round(r.top + Math.min(r.height / 2, 24));
    const dist = Math.hypot(x - s.x, y - s.y);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const d = reduce ? 0 : Math.round(Math.min(900, Math.max(320, 220 + dist * 0.55)));
    const wasOn = s.c.classList.contains('on');
    s.c.style.setProperty('--d', (wasOn ? d : 0) + 'ms');
    if (!wasOn) { s.c.getBoundingClientRect(); s.c.classList.add('on'); }
    s.c.style.setProperty('--x', x + 'px');
    s.c.style.setProperty('--y', y + 'px');
    s.x = x; s.y = y;
    keepAlive();
    return wasOn ? d : 180;
  })()`
}

/** The press: the arrow dips and a ripple opens where it points. */
export function cursorPressScript(): string {
  return `(() => {
    ${ENSURE}
    const p = document.createElement('div');
    p.className = 'r';
    p.style.setProperty('--x', s.x + 'px');
    p.style.setProperty('--y', s.y + 'px');
    s.root.appendChild(p);
    setTimeout(() => p.remove(), 700);
    s.c.classList.add('on', 'press');
    setTimeout(() => s.c.classList.remove('press'), 140);
    keepAlive();
    return true;
  })()`
}

/** Glide, wait for the glide, press, then act. Visual steps never stop the act. */
export async function withCursor<T>(evaluate: <V>(expr: string) => Promise<V>, ref: number, act: () => Promise<T>): Promise<T> {
  const raw = await evaluate<unknown>(cursorMoveScript(ref)).catch(() => -1)
  const d = typeof raw === "number" && Number.isFinite(raw) ? Math.min(raw, 1000) : -1
  if (d >= 0) await Bun.sleep(d + 60)
  await evaluate(cursorPressScript()).catch(() => undefined)
  await Bun.sleep(120)
  return act()
}
