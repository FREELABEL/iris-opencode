// Outreach strategy CRUD is implemented in platform-outreach.ts as
// PlatformOutreachCommand (command: "outreach"). This file re-exports it
// under an "outreach-strategy" alias for consistency with PHP SDK naming.
import { cmd } from "./cmd"
import { PlatformOutreachCommand } from "./platform-outreach"

export const PlatformOutreachStrategyCommand = cmd({
  ...PlatformOutreachCommand,
  command: "outreach-strategy",
  aliases: ["reachr-strategy"],
  describe: "manage outreach strategy templates (alias of `outreach`)",
})
