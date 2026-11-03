// What a command line may leave in a log: the command and the flag names, never a value (#192104).
// Argument values hold prompts and secrets, and the log is plaintext on disk at the default level.
const COMMAND = /^[a-z][a-z0-9:-]{0,39}$/
const FLAG = /^(--?[A-Za-z][A-Za-z0-9-]{0,39})(=.*)?$/s

export function argvShape(argv: string[]) {
  const end = argv.indexOf("--")
  const args = end === -1 ? argv : argv.slice(0, end)
  const flags = args.flatMap((arg) => FLAG.exec(arg)?.[1] ?? [])
  return { command: COMMAND.test(args[0] ?? "") ? args[0] : undefined, flags }
}
