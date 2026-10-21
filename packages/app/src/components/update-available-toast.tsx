import { onCleanup, onMount } from "solid-js"
import type { useLanguage } from "@/context/language"
import { dismissToast, showToast } from "@/utils/toast"

/**
 * The corner toast for a downloaded update: "Update available · Install and restart / Not yet".
 *
 * Rendered by BOTH layouts (#190253). It lived inside pages/layout.tsx, so the new layout
 * (layout-new.tsx, v2 title bar) showed only the title-bar pill — small enough that a ready
 * update sat uninstalled. The pill stays as the quick-click icon; this is the part people see.
 */
export function UpdateAvailableToast(props: {
  version: string
  install: () => void
  decline?: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: () => {
            props.decline?.()
            if (toastId !== undefined) dismissToast(toastId)
          },
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    dismissToast(toastId)
  })

  return null
}
