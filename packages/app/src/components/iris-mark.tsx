import mark from "@/assets/iris-mark.png"

/**
 * The IRIS mark — the desktop's own icon (src-tauri/icons/prod), imported so the bundle carries it in
 * both the web build and the desktop build (desktop/public has no favicon). There is no vector mark
 * yet (brand kit gap 01). The cube never animates.
 */
export function IrisMark(props: { class?: string }) {
  return <img src={mark} alt="" draggable={false} class={props.class} />
}
