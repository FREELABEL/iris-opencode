import { cmd } from "./cmd"
import { UI } from "../ui"
import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================================================
// Helpers
// ============================================================================

function remotionDir(): string {
  return join(homedir(), ".iris", "remotion")
}

function remotionInstalled(): boolean {
  return existsSync(join(remotionDir(), "package.json"))
}

function runIrisRemotion(args: string[]): void {
  const wrapper = join(homedir(), ".iris", "bin", "iris-remotion")
  if (!existsSync(wrapper)) {
    UI.error("iris-remotion not found. Run: curl -fsSL https://heyiris.io/install-code | bash")
    process.exit(1)
  }
  const result = spawnSync(wrapper, args, { stdio: "inherit", env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// ============================================================================
// Subcommands
// ============================================================================

const RenderCommand = cmd({
  command: "render <composition>",
  describe: "Render a Remotion composition to video (MP4)",
  builder: (yargs) =>
    yargs
      .positional("composition", {
        describe: "Composition name (e.g., SocialPost, BrandIntro)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output file path",
      })
      .option("props", {
        type: "string",
        describe: "JSON props for the composition",
      }),
  async handler(args) {
    const cmdArgs = ["render", args.composition as string]
    if (args.output) cmdArgs.push(args.output as string)
    if (args.props) cmdArgs.push("--props", args.props as string)
    runIrisRemotion(cmdArgs)
  },
})

const StillCommand = cmd({
  command: "still <composition>",
  describe: "Render a Remotion composition to a still image (PNG)",
  builder: (yargs) =>
    yargs
      .positional("composition", {
        describe: "Composition name (e.g., SocialPostStill, HiveAdThumbnail)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output file path",
      })
      .option("props", {
        type: "string",
        describe: "JSON props for the composition",
      }),
  async handler(args) {
    const cmdArgs = ["still", args.composition as string]
    if (args.output) cmdArgs.push(args.output as string)
    if (args.props) cmdArgs.push("--props", args.props as string)
    runIrisRemotion(cmdArgs)
  },
})

const PreviewCommand = cmd({
  command: "preview",
  describe: "Open Remotion Studio in the browser",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["preview"])
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "List available Remotion compositions",
  builder: (yargs) => yargs,
  async handler() {
    if (!remotionInstalled()) {
      UI.error("Remotion not installed. Run: curl -fsSL https://heyiris.io/install-code | bash")
      process.exit(1)
    }
    runIrisRemotion(["list"])
  },
})

const InitCommand = cmd({
  command: "init",
  describe: "(Re)install Remotion dependencies",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["init"])
  },
})

const UpdateCommand = cmd({
  command: "update",
  describe: "Update Remotion compositions from upstream",
  builder: (yargs) => yargs,
  async handler() {
    runIrisRemotion(["update"])
  },
})

const CarouselCommand = cmd({
  command: "carousel <props>",
  describe: "Batch-render all 9 carousel slides (CarouselSlide0..8)",
  builder: (yargs) =>
    yargs
      .positional("props", {
        describe: "Path to JSON file with { brand, slides: [...] }",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        type: "string",
        alias: "o",
        describe: "Output directory (default: ./carousel-<timestamp>)",
      }),
  async handler(args) {
    const cmdArgs = ["carousel", args.props as string]
    if (args.output) cmdArgs.push(args.output as string)
    runIrisRemotion(cmdArgs)
  },
})

// ============================================================================
// Main command
// ============================================================================

export const PlatformRemotionCommand = cmd({
  command: "remotion <subcommand>",
  describe: "Video & image generation with Remotion",
  builder: (yargs) =>
    yargs
      .command(RenderCommand)
      .command(StillCommand)
      .command(CarouselCommand)
      .command(PreviewCommand)
      .command(ListCommand)
      .command(InitCommand)
      .command(UpdateCommand)
      .demandCommand(1, "Specify a subcommand: render, still, carousel, preview, list, init, update"),
  async handler() {
    // handled by subcommands
  },
})
