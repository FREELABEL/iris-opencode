/**
 * Regenerate test/fixtures/golden.json from test/fixtures/heartbeats.json.
 *
 * The golden file pins what the model SAYS about every real (anonymised) heartbeat at three
 * moments — the capture, six hours on, thirty hours on — so any behaviour change shows up as a
 * diff in review. Only regenerate on purpose: `bun run golden`, then read the diff.
 */
import path from "node:path"
import { goldenOf } from "../test/golden-of"

const dir = path.resolve(import.meta.dir, "../test/fixtures")
const snap = await Bun.file(path.join(dir, "heartbeats.json")).json()
await Bun.write(path.join(dir, "golden.json"), JSON.stringify(goldenOf(snap), null, 1) + "\n")
console.log("wrote test/fixtures/golden.json")
