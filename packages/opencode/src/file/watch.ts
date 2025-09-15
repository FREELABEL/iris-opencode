import z from "zod/v4"
import { Bus } from "../bus"
import path from "path"
import chokidar from "chokidar"
import ignore from "ignore"
import { Flag } from "../flag/flag"
import { Instance } from "../project/instance"

export namespace FileWatcher {
  export const Event = {
    Updated: Bus.event(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("rename"), z.literal("change")]),
      }),
    ),
  }
  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") return {}
      const ig = ignore()
      const glob = new Bun.Glob("**/.gitignore")
      for await (const gitignorePath of glob.scan({
        cwd: Instance.directory,
        absolute: true,
        onlyFiles: true,
        dot: true,
      })) {
        const relativePath = path.relative(Instance.directory, gitignorePath)
        const dir = path.dirname(relativePath)
        const prefix = dir === "." ? "" : dir + "/"
        const content = await Bun.file(gitignorePath).text()
        const prefixed = content
          .split("\n")
          .map((line) => (line ? prefix + line : line))
          .join("\n")
        ig.add(prefixed)
      }
      const watcher = chokidar.watch(Instance.directory, {
        ignored: (filePath) => ig.ignores(filePath),
      })
      watcher.on("change", (file) => {
        Bus.publish(Event.Updated, { file, event: "change" })
      })
      watcher.on("add", (file) => {
        Bus.publish(Event.Updated, { file, event: "change" })
      })
      watcher.on("unlink", (file) => {
        Bus.publish(Event.Updated, { file, event: "change" })
      })
      return { watcher }
    },
    async (state) => {
      state.watcher?.close()
    },
  )

  export function init() {
    if (!Flag.OPENCODE_EXPERIMENTAL_WATCHER) return
    state()
  }
}
