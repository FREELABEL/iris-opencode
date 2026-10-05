import type { DictationControls } from "@opencode-ai/session-ui/v2/prompt-input/dictation"
import type { CommandOption } from "@/context/command"

export const DICTATE_COMMAND_ID = "prompt.dictate"
/** Fires inside the prompt editor too: the editable-target filter lets modified keys through. */
export const DEFAULT_DICTATE_KEYBIND = "mod+shift+space"

/**
 * The dictation shortcut. From the keyboard it is a hold — tap toggles, hold is push-to-talk —
 * so the press and release go to the control; from the palette there is no release to wait for,
 * so it toggles.
 */
export function dictateCommand(input: {
  controls: () => DictationControls | undefined
  title: string
  description: string
  category: string
}): CommandOption {
  return {
    id: DICTATE_COMMAND_ID,
    title: input.title,
    description: input.description,
    category: input.category,
    keybind: DEFAULT_DICTATE_KEYBIND,
    disabled: !input.controls(),
    onSelect: (source) => {
      const controls = input.controls()
      if (source === "keybind") controls?.press()
      else controls?.toggle()
    },
    onRelease: () => input.controls()?.release(),
  }
}
