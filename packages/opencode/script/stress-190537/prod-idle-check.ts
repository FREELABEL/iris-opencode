/** #190537 W2 — production idle-check latency on one board (read-only). bun script/stress-190537/prod-idle-check.ts 297 */
import { irisFetch, resolveUserId } from "../../src/cli/cmd/iris-api"
const bloq = Number(process.argv[2] ?? 297)
const n = Number(process.argv[3] ?? 10)
const userId = await resolveUserId()
const v = (await (await irisFetch(`/api/v1/user/${userId}/bloqs/${bloq}?skeleton=1`)).json())?.data?.version
const ms: number[] = []
let unchanged = 0
for (let i = 0; i < n; i++) {
  const t = performance.now()
  const j = await (await irisFetch(`/api/v1/user/${userId}/bloqs/${bloq}?if_version=${v}`)).json()
  ms.push(performance.now() - t)
  if (j?.data?.unchanged) unchanged++
}
// the floor: a request that does almost nothing, to separate network from server work
const floor: number[] = []
for (let i = 0; i < n; i++) {
  const t = performance.now()
  await irisFetch(`/api/v1/user/${userId}/bloqs/811?if_version=x`)
  floor.push(performance.now() - t)
}
const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)].toFixed(0)
console.log(`board ${bloq}: idle check p50 ${p(ms, 0.5)} ms p90 ${p(ms, 0.9)} ms (${unchanged}/${n} unchanged) · scratch-board floor p50 ${p(floor, 0.5)} ms`)
