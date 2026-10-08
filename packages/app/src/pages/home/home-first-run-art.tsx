/**
 * Art for the first-run screen (EPIC #188210). Drawn, not imported: the hero says what IRIS does
 * with the inbox — mail comes in, IRIS reads it, drafts come out, nothing is sent — so it has to
 * be exactly that picture, and it has to follow the app theme through currentColor and tokens.
 */

/** The official Gmail mark (2020), unmodified geometry and colours. */
export function GmailLogo(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="52 42 88 66" role="img" aria-label="Gmail">
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
    </svg>
  )
}

/** The Outlook mark: tiled mail panel behind the blue "O" tile. */
export function OutlookLogo(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 48 48" role="img" aria-label="Outlook">
      <rect x="16" y="6" width="28" height="36" rx="3" fill="#0364b8" />
      <rect x="16" y="6" width="14" height="12" fill="#0078d4" />
      <rect x="30" y="6" width="14" height="12" rx="0" fill="#28a8ea" />
      <rect x="16" y="18" width="14" height="12" fill="#14447d" opacity=".9" />
      <rect x="30" y="18" width="14" height="12" fill="#0078d4" />
      <path d="M16 26h28v13a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" fill="#1490df" />
      <path d="M16 26l14 9 14-9" fill="none" stroke="#0a2767" stroke-opacity=".35" stroke-width="1.2" />
      <rect x="4" y="14" width="22" height="22" rx="3" fill="#0f5fb0" />
      <ellipse cx="15" cy="25" rx="5.4" ry="6.6" fill="none" stroke="#fff" stroke-width="2.6" />
    </svg>
  )
}

/** The IRIS cube — same geometry as IrisMark in the titlebar. */
function Cube(props: { x: number; y: number; s: number }) {
  const k = props.s / 24
  return (
    <g transform={`translate(${props.x - 12 * k} ${props.y - 12 * k}) scale(${k})`} fill="currentColor">
      <path d="M12 2.4 21.4 7 12 11.6 2.6 7Z" />
      <path d="M2.6 8.1 11.6 12.6 11.6 21.6 2.6 17.1Z" />
      <path d="M21.4 8.1 12.4 12.6 12.4 21.6 21.4 17.1Z" />
    </g>
  )
}

function Envelope(props: { y: number; i: number }) {
  return (
    <g class="fr-env" style={{ "--i": props.i }} transform={`translate(18 ${props.y})`}>
      <rect width="58" height="38" rx="6" class="fr-card" />
      <path d="M6 8l23 15 23-15" class="fr-stroke" />
      <rect x="8" y="27" width="22" height="3" rx="1.5" class="fr-faint" />
    </g>
  )
}

/**
 * Inbox → IRIS → drafts. `reading` loops the travel for the "Reading your mail" step; otherwise
 * it plays once on arrival. Both stop under prefers-reduced-motion (see home-first-run.css).
 */
export function InboxArt(props: { reading?: boolean }) {
  return (
    <svg class="fr-art" classList={{ "is-reading": !!props.reading }} viewBox="0 0 400 150" aria-hidden="true">
      <defs>
        <radialGradient id="fr-glow">
          <stop offset="0" stop-color="currentColor" stop-opacity=".22" />
          <stop offset="1" stop-color="currentColor" stop-opacity="0" />
        </radialGradient>
      </defs>

      {/* Your mail */}
      <Envelope y={14} i={0} />
      <Envelope y={56} i={1} />
      <Envelope y={98} i={2} />

      {/* Paths in: three envelopes converge on IRIS */}
      <path class="fr-flow" d="M80 33 C130 33 140 75 176 75" />
      <path class="fr-flow" d="M80 75 L176 75" />
      <path class="fr-flow" d="M80 117 C130 117 140 75 176 75" />

      {/* IRIS */}
      <circle cx="200" cy="75" r="58" fill="url(#fr-glow)" class="fr-halo" />
      <circle cx="200" cy="75" r="30" class="fr-ring" />
      <g class="fr-cube">
        <Cube x={200} y={75} s={34} />
      </g>

      {/* Path out: one draft, waiting for you */}
      <path class="fr-flow fr-out" d="M226 75 L296 75" />
      <g class="fr-draft" transform="translate(300 40)">
        <rect width="82" height="70" rx="8" class="fr-card" />
        <rect x="10" y="12" width="40" height="4" rx="2" class="fr-ink" />
        <rect x="10" y="24" width="60" height="3" rx="1.5" class="fr-faint" />
        <rect x="10" y="32" width="54" height="3" rx="1.5" class="fr-faint" />
        <rect x="10" y="40" width="58" height="3" rx="1.5" class="fr-faint" />
        <rect x="10" y="52" width="30" height="10" rx="5" class="fr-chip" />
        <text x="25" y="59.5" text-anchor="middle" class="fr-chip-text">
          Draft
        </text>
      </g>
    </svg>
  )
}

export function Spinner(props: { class?: string }) {
  return (
    <svg class={`fr-spin ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  )
}

export function Check(props: { class?: string }) {
  return (
    <svg class={`fr-check ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#16a34a" />
      <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
