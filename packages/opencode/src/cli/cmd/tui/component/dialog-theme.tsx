import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogTheme() {
  const { mode, setMode } = useTheme()
  const dialog = useDialog()

  const options = () => [
    {
      key: "dark",
      value: "dark",
      title: "Dark",
      description: "Use dark theme",
      category: "Theme",
    },
    {
      key: "light",
      value: "light",
      title: "Light",
      description: "Use light theme",
      category: "Theme",
    },
    {
      key: "auto",
      value: "auto",
      title: "Auto",
      description: "Automatically switch based on system preference",
      category: "Theme",
    },
  ]

  return (
    <DialogSelect
      title="Select Theme"
      current={mode()}
      options={options()}
      onSelect={(option) => {
        setMode(option.value as "dark" | "light" | "auto")
        dialog.clear()
      }}
    />
  )
}
