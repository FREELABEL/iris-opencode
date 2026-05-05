import { cmd } from "./cmd"

export const HiveNodesCommandExport = cmd({
  command: "nodes",
  describe: "List and manage registered compute nodes",
  handler: async () => {
    console.log("hive nodes — coming soon")
  },
})

export const HiveRunCommandExport = cmd({
  command: "run <task>",
  describe: "Run a task on a compute node",
  builder: (y) => y.positional("task", { type: "string", demandOption: true }),
  handler: async () => {
    console.log("hive run — coming soon")
  },
})
