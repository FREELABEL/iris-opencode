import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Shell } from "@opencode/core/shell"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const mode = (target: string) => Effect.promise(async () => (await fs.stat(target)).mode & 0o777)

describe.skipIf(process.platform === "win32")("private files (#192119)", () => {
  it.live("an existing install's data, log and shell output are tightened", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const log = path.join(tmp.path, "log")
        const project = path.join(tmp.path, Shell.DIRECTORY, "project")
        const oldLog = path.join(log, "opencode.log")
        const output = path.join(project, "sh_0123456789abABCDEFGHIJKLMN.out")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(log, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(oldLog, "canary")
            await fs.writeFile(output, "canary")
            await Promise.all([
              fs.chmod(tmp.path, 0o755),
              fs.chmod(log, 0o755),
              fs.chmod(project, 0o755),
              fs.chmod(oldLog, 0o644),
              fs.chmod(output, 0o644),
            ])
          })
          yield* Effect.gen(function* () {
            yield* Global.Service
            yield* Shell.cleanup()
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node]), [
                Global.node.replace(Global.layerWith({ data: tmp.path, log })),
              ]),
            ),
          )
          expect(yield* mode(tmp.path)).toBe(0o700)
          expect(yield* mode(log)).toBe(0o700)
          expect(yield* mode(oldLog)).toBe(0o600)
          expect(yield* mode(path.join(tmp.path, Shell.DIRECTORY))).toBe(0o700)
          expect(yield* mode(project)).toBe(0o700)
          expect(yield* mode(output)).toBe(0o600)
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
