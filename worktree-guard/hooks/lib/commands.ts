/**
 * Recognizes the git commands the guard cares about inside a Bash command line.
 * Best effort by design: aliases, scripts and eval slip through; the guard is a safety net.
 */

export type GuardedCommand = (
  /** Sweeps files into the index; `paths` empty means the whole tree. */
  | { kind: 'stage'; isTrackedOnly: boolean; paths: string[] }
  | { kind: 'stash'; withUntracked: boolean }
  /** Overwrites working-tree files from the index (`source` absent) or from a commit. */
  | { kind: 'discard'; source?: string; paths: string[] }
  /** Deletes untracked files; `args` is the dry-run argument list that mirrors the command. */
  | { kind: 'clean'; args: string[] }
) & {
  /** Where the command runs, relative to the session's directory ('' = there), from `cd` and `git -C`. */
  dir: string
}

/** Drops here-document bodies, so text inside a commit message is never read as a command. */
export function stripHeredocs(command: string): string {
  const kept: string[] = []
  let terminator: string | null = null
  let isTabStripped = false
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if ((isTabStripped ? line.replace(/^\t+/, '') : line) === terminator) terminator = null
      continue
    }
    kept.push(line)
    const open = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/)
    if (open) {
      terminator = open[3] ?? null
      isTabStripped = open[1] === '-'
    }
  }
  return kept.join('\n')
}

/**
 * Splits a command line into simple commands on unquoted `&&`, `||`, `;`, `|`, `&`,
 * newlines and parentheses, each as its unquoted words.
 */
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  const text = stripHeredocs(command)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text[++i]
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i] ?? ''
      if (next !== '\n') {
        word += next
        hasWord = true
      }
    } else if (/[;&|\n()]/.test(ch)) {
      endCommand()
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      word += ch
      hasWord = true
    }
  }
  endCommand()
  return commands
}

/** Words that run the command after them unchanged. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'builtin', '{'])
/** git's global options that take a value as the next word. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const STASH_SUBCOMMANDS = new Set(['push', 'save', 'list', 'show', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store'])

/** Joins `cd` and `-C` steps the way the shell and git would, staying relative when they are. */
export function joinDir(base: string, step: string): string {
  if (step.startsWith('/')) return step
  if (step === '' || step === '.') return base
  return base ? `${base}/${step}` : step
}

/** Returns every guarded git command in the line, in order, each with the directory it runs in. */
export function findGuarded(command: string): GuardedCommand[] {
  const found: GuardedCommand[] = []
  let dir = ''
  for (const words of simpleCommands(command)) {
    let at = 0
    while (at < words.length && (WRAPPERS.has(words[at] ?? '') || /^[A-Za-z_]\w*=/.test(words[at] ?? ''))) at++
    const name = words[at] ?? ''
    if (name === 'cd') {
      dir = joinDir(dir, words[at + 1] ?? '')
      continue
    }
    if (name !== 'git' && !name.endsWith('/git')) continue
    let runIn = dir
    let i = at + 1
    while (i < words.length && (words[i] ?? '').startsWith('-')) {
      const option = words[i] ?? ''
      if (option === '-C') runIn = joinDir(runIn, words[i + 1] ?? '')
      i += GLOBAL_WITH_VALUE.has(option) ? 2 : 1
    }
    const one = match(words[i], words.slice(i + 1))
    if (one) found.push({ ...one, dir: runIn })
  }
  return found
}

type Parsed = GuardedCommand extends infer G ? (G extends GuardedCommand ? Omit<G, 'dir'> : never) : never

function match(verb: string | undefined, args: string[]): Parsed | null {
  const dash = args.indexOf('--')
  const before = dash >= 0 ? args.slice(0, dash) : args
  const afterDash = dash >= 0 ? args.slice(dash + 1) : []
  const flags = before.filter(arg => arg.startsWith('-'))
  const operands = before.filter(arg => !arg.startsWith('-'))
  const hasShort = (letter: string) => flags.some(flag => /^-[a-zA-Z]+$/.test(flag) && flag.includes(letter))
  const has = (...names: string[]) => flags.some(flag => names.includes(flag))

  switch (verb) {
    case 'add': {
      const paths = [...operands, ...afterDash]
      const isTrackedOnly = has('-u', '--update')
      if (paths.includes(':/')) return { kind: 'stage', isTrackedOnly, paths: [] }
      if (isTrackedOnly || has('-A', '--all')) return { kind: 'stage', isTrackedOnly, paths }
      return paths.includes('.') ? { kind: 'stage', isTrackedOnly: false, paths } : null
    }
    case 'commit':
      return has('--all') || hasShort('a') ? { kind: 'stage', isTrackedOnly: true, paths: [] } : null
    case 'stash': {
      const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'push'
      if (!STASH_SUBCOMMANDS.has(sub) || (sub !== 'push' && sub !== 'save')) return null
      return { kind: 'stash', withUntracked: has('-u', '--include-untracked', '-a', '--all') }
    }
    case 'checkout': {
      if (dash >= 0) return { kind: 'discard', source: operands[0], paths: afterDash }
      if (operands.includes('.')) return { kind: 'discard', source: operands.find(o => o !== '.'), paths: ['.'] }
      return has('-f', '--force') ? { kind: 'discard', source: 'HEAD', paths: [] } : null
    }
    case 'switch':
      return has('-f', '--force', '--discard-changes') ? { kind: 'discard', source: 'HEAD', paths: [] } : null
    case 'restore': {
      const isStaged = has('--staged') || hasShort('S')
      const isWorktree = has('--worktree') || hasShort('W')
      if (isStaged && !isWorktree) return null
      let source: string | undefined
      const rest: string[] = []
      for (let i = 0; i < before.length; i++) {
        const arg = before[i] ?? ''
        if (arg === '-s' || arg === '--source') source = before[++i]
        else if (arg.startsWith('--source=')) source = arg.slice('--source='.length)
        else if (!arg.startsWith('-')) rest.push(arg)
      }
      const paths = [...rest, ...afterDash]
      return { kind: 'discard', source: source ?? (isStaged ? 'HEAD' : undefined), paths: paths.length ? paths : ['.'] }
    }
    case 'reset':
      return has('--hard') ? { kind: 'discard', source: operands[0] ?? 'HEAD', paths: [] } : null
    case 'clean':
      return cleanPreview(args)
    default:
      return null
  }
}

/** Mirrors a `git clean` as `git clean -n` with the same scope; null when it is a dry run already. */
function cleanPreview(args: string[]): Parsed | null {
  const preview: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-n' || arg === '--dry-run') return null
    if (arg === '--') {
      preview.push(...args.slice(i))
      break
    }
    if (arg === '-e' || arg === '--exclude') {
      preview.push(arg, args[++i] ?? '')
    } else if (arg.startsWith('--exclude=')) {
      preview.push(arg)
    } else if (['--force', '--interactive', '--quiet'].includes(arg)) {
      continue
    } else if (/^-[a-zA-Z]/.test(arg) && (/^-[a-zA-Z]+$/.test(arg) || arg.includes('e'))) {
      // -e takes its value glued (`-epat`) or as the next word; letters before it are plain switches.
      const at = arg.indexOf('e')
      const switches = at >= 0 ? arg.slice(1, at) : arg.slice(1)
      if (switches.includes('n')) return null
      const letters = switches.replace(/[fiq]/g, '')
      if (letters) preview.push(`-${letters}`)
      if (at >= 0) preview.push('-e', arg.slice(at + 1) || (args[++i] ?? ''))
    } else {
      preview.push(arg)
    }
  }
  return { kind: 'clean', args: preview }
}

/** Pulls the port out of a server's "address in use" error, if the text has one. */
export function busyPort(text: string): number | null {
  for (const line of text.split('\n')) {
    if (!/listen EADDRINUSE|EADDRINUSE:|address already in use/i.test(line)) continue
    const named = line.match(/port\D{0,3}(\d{2,5})\b/i)
    const colons = [...line.matchAll(/:(\d{2,5})\b/g)]
    const port = Number(named?.[1] ?? colons[colons.length - 1]?.[1])
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  }
  return null
}
