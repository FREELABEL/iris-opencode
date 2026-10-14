import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: (SnapshotFileDiff | FileDiffInfo)[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

/** A failed command, as the Report button sends it (#189435). The app decides what happens next. */
export type CommandReportInput = { tool: string; command: string; error: string; output?: string }
export type ReportCommandFn = (report: CommandReportInput) => void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    sessionID?: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onReportCommand?: ReportCommandFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      get reportCommand() {
        return props.onReportCommand
      },
    }
  },
})
