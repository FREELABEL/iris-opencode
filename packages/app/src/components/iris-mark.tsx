import mark from "@/assets/iris-mark.png"

/**
 * The IRIS mark — the desktop's own icon (src-tauri/icons/prod), imported so the bundle carries it in
 * both the web build and the desktop build (desktop/public has no favicon). There is no vector mark
 * yet (brand kit gap 01). The cube never animates.
 */
export function IrisMark(props: { class?: string }) {
  return <img src={mark} alt="" draggable={false} class={props.class} />
}

/** The IRIS lockup — the mark beside the name in the brand sans at 500 (the kit has no bold, and no wordmark artwork yet). */
export function IrisWordmark(props: { class?: string }) {
  return (
    <div class={`flex items-center justify-center gap-4 ${props.class ?? ""}`}>
      <IrisMark class="size-12 rounded-[11px]" />
      <span class="text-[56px] leading-none font-medium tracking-[-0.02em]">IRIS</span>
    </div>
  )
}
