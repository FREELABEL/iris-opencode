import { cmd } from "./cmd"

export const HiveScanCommandExport = cmd({
  command: "scan",
  describe: "Scan local network for available compute nodes",
  handler: async () => {
    console.log("hive scan — coming soon")
  },
})

export const HiveProbeCommandExport = cmd({
  command: "probe <target>",
  describe: "Probe a specific node for capabilities",
  builder: (y) => y.positional("target", { type: "string", demandOption: true }),
  handler: async () => {
    console.log("hive probe — coming soon")
  },
})

export const HiveSshCommandExport = cmd({
  command: "ssh <target>",
  describe: "SSH into a compute node",
  builder: (y) => y.positional("target", { type: "string", demandOption: true }),
  handler: async () => {
    console.log("hive ssh — coming soon")
  },
})
