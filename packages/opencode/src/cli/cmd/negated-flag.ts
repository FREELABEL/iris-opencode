/**
 * Literal `--no-x` flags (#193782, #184593).
 *
 * `src/index.ts` runs yargs with `boolean-negation` OFF, so `--no-x` is an unknown
 * argument unless a command registers `no-x` itself. Six commands promised `--no-x`
 * in their help and registered nothing, so the advertised form failed with
 * "Unknown arguments: no-x, noX" while an undocumented `--x=false` worked.
 *
 * Each command registers the literal `no-x` option and a middleware calling `applyNegation`,
 * which turns `--no-x` into `x = false` before the handler runs, so a handler keeps reading `x`
 * and never needs to know two spellings exist. `--x` and `--no-x` together is refused.
 */
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** Pure, so it can be tested without yargs: apply `--no-<name>` to argv in place. */
export function applyNegation(argv: Record<string, unknown>, name: string): void {
  const neg = `no-${name}`
  if (argv[neg] !== true) return
  if (argv[name] === true && process.argv.includes(`--${name}`)) {
    throw new Error(`--${name} and --${neg} contradict each other — pass one`)
  }
  argv[name] = false
  argv[camel(name)] = false
}
