import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { JSX } from "solid-js"

/**
 * Shown under the upgrade button on every prompt that leads to paying. One string, here, so the
 * promise cannot drift between prompts. It is a commitment to customers: the Terms page and the
 * refund process must say the same thing.
 */
export const UPGRADE_GUARANTEE = "30-day money-back guarantee — full refund, no questions asked."

export type DialogGoUpsellProps = {
  title: string
  description: JSX.Element
  link?: string
  actionLabel: string
  /** Risk reversal next to the ask. Pass UPGRADE_GUARANTEE when the action leads to paying. */
  guarantee?: string
  onClose?: (dontShowAgain?: boolean) => void
}

export function DialogUsageExceeded(props: DialogGoUpsellProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const runAction = () => {
    if (props.link) platform.openExternal(props.link)
    props.onClose?.()
    dialog.close()
  }

  const dismiss = () => {
    props.onClose?.(true)
    dialog.close()
  }

  return (
    <Dialog title={props.title} description={props.description} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={dismiss}>
            {language.t("dialog.usageExceeded.dontShowAgain")}
          </Button>
          <Button variant="primary" size="large" onClick={runAction}>
            {props.actionLabel}
          </Button>
        </div>
        {props.guarantee && <p class="text-right text-12-regular text-text-weak">{props.guarantee}</p>}
      </div>
    </Dialog>
  )
}
