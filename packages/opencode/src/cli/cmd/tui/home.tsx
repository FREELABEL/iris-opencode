import { Installation } from "../../../installation"
import { useTheme } from "./context/theme"
import { TextAttributes } from "@opentui/core"
import { Prompt } from "./component/prompt"

export function Home() {
  const { currentTheme } = useTheme()
  const theme = currentTheme()

  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <box>
        <Logo theme={theme} />
        <box paddingTop={2}>
          <HelpRow slash="new" theme={theme}>
            new session
          </HelpRow>
          <HelpRow slash="help" theme={theme}>
            show help
          </HelpRow>
          <HelpRow slash="share" theme={theme}>
            share session
          </HelpRow>
          <HelpRow slash="models" theme={theme}>
            list models
          </HelpRow>
          <HelpRow slash="agents" theme={theme}>
            list agents
          </HelpRow>
        </box>
      </box>
      <box paddingTop={3} minWidth={75}>
        <Prompt />
      </box>
    </box>
  )
}

function HelpRow(props: { children: string; slash: string; theme: any }) {
  return (
    <text>
      <span style={{ bold: true, fg: props.theme.primary }}>/{props.slash.padEnd(10, " ")}</span>
      <span>{props.children.padEnd(15, " ")} </span>
      <span style={{ fg: props.theme.textMuted }}>ctrl+x n</span>
    </text>
  )
}

function Logo(props: { theme: any }) {
  return (
    <box>
      <box flexDirection="row">
        <text fg={props.theme.textMuted}>{"█▀▀█ █▀▀█ █▀▀ █▀▀▄"}</text>
        <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
          {" █▀▀ █▀▀█ █▀▀▄ █▀▀"}
        </text>
      </box>
      <box flexDirection="row">
        <text fg={props.theme.textMuted}>{`█░░█ █░░█ █▀▀ █░░█`}</text>
        <text fg={props.theme.text}>{` █░░ █░░█ █░░█ █▀▀`}</text>
      </box>
      <box flexDirection="row">
        <text fg={props.theme.textMuted}>{`▀▀▀▀ █▀▀▀ ▀▀▀ ▀  ▀`}</text>
        <text fg={props.theme.text}>{` ▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀`}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end">
        <text fg={props.theme.textMuted}>{Installation.VERSION}</text>
      </box>
    </box>
  )
}
