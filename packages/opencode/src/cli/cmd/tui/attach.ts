import { cmd } from "../cmd"
import { tui } from "./app"
import { UI } from "@/cli/ui"
import { LocalAuth } from "@/server/local-auth"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "server password (default: OPENCODE_SERVER_PASSWORD, or this machine's server record)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "server username (default: OPENCODE_SERVER_USERNAME, or opencode)",
      }),
  handler: async (args) => {
    if (args.dir) process.chdir(args.dir)
    const directory = process.cwd()
    const headers = LocalAuth.headersFor(args.url, { password: args.password, username: args.username })
    const problem = await LocalAuth.attachProblem(args.url, headers)
    if (problem) {
      UI.error(problem)
      process.exitCode = 1
      return
    }
    await tui({
      url: args.url,
      headers,
      args: { sessionID: args.session },
      directory,
    })
  },
})
