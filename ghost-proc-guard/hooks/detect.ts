// Pure helpers: recognise dev-server commands, infer their port, parse lsof output.

const SCRIPT_RUN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(dev|start|serve|preview|storybook)\b/

// Order matters: more specific patterns first.
const DEFAULTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bvite\s+preview\b/, 4173],
  [/\bvite(?:\s+(?:dev|serve))?(?:\s+-|\s*$|\s+[^b\s])/, 5173],
  [/\bnext\s+(?:dev|start)\b/, 3000],
  [/\bastro\s+(?:dev|preview)\b/, 4321],
  [/\bnuxi?\s+dev\b/, 3000],
  [/\bremix\s+dev\b/, 3000],
  [/\bstorybook\s+dev\b/, 6006],
  [/\bwrangler\s+dev\b/, 8787],
  [/\bexpo\s+start\b/, 8081],
  [/\bwebpack(?:-dev-server|\s+serve)\b/, 8080],
  [/\bparcel(?:\s+serve)?\s+\S+\.html\b/, 1234],
  [/\brails\s+s(?:erver)?\b/, 3000],
  [/\buvicorn\b/, 8000],
  [/\bflask\s+run\b/, 5000],
  [/\bpython3?\s+-m\s+http\.server\b/, 8000],
  [/\bphp\s+-S\b/, 8000],
  [/\bhugo\s+server\b/, 1313],
  [/\bjekyll\s+serve\b/, 4000],
]

export type DevCommand = {
  /** Directory the command runs in, after a leading `cd dir &&`. */
  cwd: string
  /** Port the server will bind, when it can be told from the command. */
  port?: number
  /** `npm run <script>` style: the script whose body decides the port. */
  script?: string
  /** A workspace runner (`turbo run dev`, `pnpm -r dev`): the task each package runs. */
  task?: string
}

/** Recognises a command that starts a long-running dev server. */
export function detectDevCommand(command: string, sessionCwd: string): DevCommand | undefined {
  const { cwd, rest } = splitCd(stripQuoted(stripHeredocs(command)), sessionCwd)
  const task = workspaceTask(rest)
  if (task !== undefined) return { cwd, task }
  const script = rest.match(SCRIPT_RUN)?.[1]
  const port = explicitPort(rest) ?? defaultPort(rest)
  if (script === undefined && port === undefined) return undefined
  return { cwd, port, script: port === undefined ? script : undefined }
}

/** Infers the port from a package.json script body (`vite --port 5175`). */
export function portFromScript(body: string): number | undefined {
  return explicitPort(body) ?? defaultPort(body)
}

export function explicitPort(text: string): number | undefined {
  const m =
    text.match(/(?:--port[=\s]+|\s-p\s+|\bPORT=)(\d{2,5})\b/) ??
    text.match(/\bhttp\.server\s+(\d{2,5})\b/) ??
    text.match(/\bphp\s+-S\s+\S*:(\d{2,5})\b/) ??
    text.match(/--bind[=\s]+\S*:(\d{2,5})\b/)
  return m ? Number(m[1]) : undefined
}

export function defaultPort(text: string): number | undefined {
  for (const [re, port] of DEFAULTS) if (re.test(text)) return port
  return undefined
}

/** Drops heredoc bodies (`<<EOF ... EOF`, `<<-'X' ... X`), keeping the command lines around them. */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  let end: string | undefined
  let isTabbed = false
  for (const line of lines) {
    if (end !== undefined) {
      if ((isTabbed ? line.replace(/^\t+/, '') : line) === end) end = undefined
      continue
    }
    out.push(line)
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/)
    if (m) {
      isTabbed = m[1] === '-'
      end = m[3]
    }
  }
  return out.join('\n')
}

/**
 * Drops quoted arguments (`printf '...'`, `grep "npm run dev"`): text handed to a
 * program, not a command run. A string after `-c` is a command, so it stays.
 */
export function stripQuoted(command: string): string {
  return command.replace(/(?<!-c\s+)(['"])(?:\\.|(?!\1)[\s\S])*\1/g, "''")
}

/** The variable a guarded launch carries, inherited by every process it starts. */
export const MARKER = 'GHOST_PROC_GUARD_SESSION'

/** Parses `ps -wwE -o pid=,command=` into pid -> the session id its environment carries. */
export function parseMarkers(out: string): Map<number, string> {
  const map = new Map<number, string>()
  const re = new RegExp(`(?:^|\\s)${MARKER}=(\\S+)`)
  for (const line of out.split('\n')) {
    const pid = Number(line.trim().split(/\s+/)[0])
    const m = line.match(re)
    if (pid > 0 && m) map.set(pid, m[1])
  }
  return map
}

function splitCd(command: string, cwd: string): { cwd: string; rest: string } {
  const m = command.trim().match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]*)$/)
  if (!m) return { cwd, rest: command }
  const dir = m[1].replace(/^["']|["']$/g, '')
  return { cwd: resolvePath(cwd, dir), rest: m[2] }
}

export function resolvePath(base: string, path: string): string {
  if (path.startsWith('/')) return normalise(path)
  return normalise(`${base}/${path}`)
}

function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

export type Listener = { pid: number; name: string; port: number }

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: one entry per (pid, port). */
export function parseListeners(out: string): Listener[] {
  const seen = new Set<string>()
  const list: Listener[] = []
  let pid = 0
  let name = ''
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') pid = Number(value)
    else if (tag === 'c') name = value
    else if (tag === 'n') {
      const port = Number(value.slice(value.lastIndexOf(':') + 1))
      const id = `${pid}:${port}`
      if (Number.isFinite(port) && port > 0 && !seen.has(id)) {
        seen.add(id)
        list.push({ pid, name, port })
      }
    }
  }
  return list
}

/** Parses `lsof -a -d cwd -p a,b -Fpn` into pid -> cwd. */
export function parseCwds(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n') map.set(pid, line.slice(1))
  }
  return map
}

export type Holder = { pid: number; name: string; port: number; ports: number[] }

/** One entry per process: its lowest port as the main one, every port it holds sorted. */
export function groupByPid(list: readonly Listener[]): Holder[] {
  const byPid = new Map<number, Holder>()
  for (const l of list) {
    const one = byPid.get(l.pid) ?? { pid: l.pid, name: l.name, port: l.port, ports: [] }
    if (!one.ports.includes(l.port)) one.ports.push(l.port)
    one.ports.sort((a, b) => a - b)
    one.port = one.ports[0]
    byPid.set(l.pid, one)
  }
  return [...byPid.values()]
}

export type Tree = Map<number, { ppid: number; command: string }>

/** Parses `ps -A -o pid=,ppid=,command=`. */
export function parsePs(out: string): Tree {
  const tree: Tree = new Map()
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (m) tree.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] })
  }
  return tree
}

const MAX_DEPTH = 12

/** The chain of parents above `pid`, nearest first, stopping before any pid in `stop`. */
export function ancestors(pid: number, tree: Tree, stop: ReadonlySet<number> = new Set()): number[] {
  const chain: number[] = []
  let cur = tree.get(pid)?.ppid
  while (cur !== undefined && cur > 1 && !stop.has(cur) && chain.length < MAX_DEPTH) {
    chain.push(cur)
    cur = tree.get(cur)?.ppid
  }
  return chain
}

/** A login or bare interactive shell: someone's terminal, never part of an app. */
function isInteractiveShell(command: string): boolean {
  const cmd = command.trim()
  return cmd.startsWith('-') || /^(\S*\/)?(zsh|bash|sh|fish|dash|nu|tmux)$/.test(cmd)
}

/**
 * The top of the run of processes above `pid` sharing its working directory:
 * the process that launched the app (wrangler above its workerds, pnpm above
 * vite). Never climbs into `stop` (Claude's own chain) or an interactive shell.
 */
export function rootOf(pid: number, tree: Tree, cwds: ReadonlyMap<number, string>, stop: ReadonlySet<number>): number {
  const cwd = cwds.get(pid)
  if (cwd === undefined) return pid
  let root = pid
  for (const parent of ancestors(pid, tree, stop)) {
    const info = tree.get(parent)
    if (!info || cwds.get(parent) !== cwd || isInteractiveShell(info.command)) break
    root = parent
  }
  return root
}

/** Every process below `root`, depth first. */
export function descendants(root: number, tree: Tree): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, { ppid }] of tree) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const out: number[] = []
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/** Ports the OS hands out on demand: a runtime's internal sockets, never one people browse to. */
export const EPHEMERAL_FROM = 49152

/** The ports worth showing: the main one first, then the other fixed ones (inspector and the like). */
export function shownPorts(p: { port?: number; ports?: readonly number[] }): number[] {
  const fixed = (p.ports ?? []).filter(x => x < EPHEMERAL_FROM && x !== p.port)
  return p.port === undefined ? fixed : [p.port, ...fixed]
}

/** Prefers a fixed port (below the ephemeral range) as the one people browse to. */
export function mainPort(ports: readonly number[]): number {
  const sorted = [...ports].sort((a, b) => a - b)
  return sorted.find(p => p < EPHEMERAL_FROM) ?? sorted[0]
}

export type Group = { root: number; members: number[]; names: string[]; ports: number[]; port: number }

/** Folds listening processes into one entry per app root. */
export function groupByRoot(holders: readonly Holder[], root: (pid: number) => number): Group[] {
  const byRoot = new Map<number, Group>()
  for (const h of holders) {
    const key = root(h.pid)
    const g = byRoot.get(key) ?? { root: key, members: [], names: [], ports: [], port: 0 }
    g.members.push(h.pid)
    g.names.push(h.name)
    for (const p of h.ports) if (!g.ports.includes(p)) g.ports.push(p)
    g.ports.sort((a, b) => a - b)
    g.port = mainPort(g.ports)
    byRoot.set(key, g)
  }
  return [...byRoot.values()]
}

const TASK = '(dev|start|serve|preview)'
const RUNNERS: readonly RegExp[] = [
  new RegExp(`\\bturbo\\s+(?:run\\s+)?${TASK}\\b`),
  new RegExp(`\\bnx\\s+run-many\\b[^\\n;&|]*--targets?[=\\s]${TASK}\\b`),
  new RegExp(`\\blerna\\s+run\\s+${TASK}\\b`),
  new RegExp(`\\bpnpm\\b[^\\n;&|]*?\\s(?:-r|--recursive|--filter[=\\s]\\S+|-F\\s+\\S+)\\b[^\\n;&|]*?\\s(?:run\\s+)?${TASK}\\b`),
  new RegExp(`\\b(?:npm|yarn)\\s+run\\s+${TASK}\\s+(?:--workspaces?\\b|-ws\\b)`),
]

/** The task a workspace runner starts in every package (`turbo run dev` -> `dev`). */
export function workspaceTask(text: string): string | undefined {
  for (const re of RUNNERS) {
    const m = text.match(re)
    if (m) return m[1]
  }
  return undefined
}

export type Filters = { include: string[]; exclude: string[] }

/** Reads `--filter=x`, `--filter !x`, `-F x` (turbo's `...` dependency marks dropped). */
export function parseFilters(text: string): Filters {
  const filters: Filters = { include: [], exclude: [] }
  for (const m of text.matchAll(/(?:--filter[=\s]+|(?:^|\s)-F\s+)(['"]?)([^\s'"]+)\1/g)) {
    const value = m[2].replace(/^\.\.\.|\.\.\.$/g, '')
    if (value.startsWith('!')) filters.exclude.push(value.slice(1))
    else filters.include.push(value)
  }
  return filters
}

function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return re.test(value)
}

/** Whether a package (by name or `./relative/dir`) passes the runner's filters. */
export function matchesFilters(name: string | undefined, dir: string, f: Filters): boolean {
  const hits = (g: string) => (name !== undefined && globMatch(g, name)) || globMatch(g.replace(/^\.\//, ''), dir)
  if (f.include.length > 0 && !f.include.some(hits)) return false
  return !f.exclude.some(hits)
}

/** Workspace globs from pnpm-workspace.yaml or package.json `workspaces`. */
export function workspaceGlobs(pnpmYaml: string | undefined, pkg: unknown): string[] {
  const globs: string[] = []
  if (pnpmYaml !== undefined) {
    let isInPackages = false
    for (const line of pnpmYaml.split('\n')) {
      if (/^packages\s*:/.test(line)) isInPackages = true
      else if (/^\S/.test(line)) isInPackages = false
      else if (isInPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/)
        if (m && !m[1].startsWith('!')) globs.push(m[1])
      }
    }
  }
  const ws = (pkg as { workspaces?: unknown } | undefined)?.workspaces
  const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages
  if (Array.isArray(list)) for (const g of list) if (typeof g === 'string' && !g.startsWith('!')) globs.push(g)
  return [...new Set(globs.map(g => g.replace(/^\.\//, '').replace(/\/$/, '')))]
}

/** Config files that can fix a dev server's port, by the tool that reads them. */
export const CONFIG_FILES: ReadonlyArray<readonly [string, RegExp]> = [
  ['vite.config.ts', /\bvite\b/], ['vite.config.mts', /\bvite\b/], ['vite.config.js', /\bvite\b/], ['vite.config.mjs', /\bvite\b/],
  ['astro.config.mjs', /\bastro\b/], ['astro.config.ts', /\bastro\b/], ['astro.config.js', /\bastro\b/],
  ['wrangler.toml', /\bwrangler\b/], ['wrangler.jsonc', /\bwrangler\b/], ['wrangler.json', /\bwrangler\b/],
]

/** The port a config file pins (vite/astro `port:`, wrangler `[dev] port`). */
export function configPort(name: string, text: string): number | undefined {
  const m = name.endsWith('.toml')
    ? text.match(/^\[dev\][^[]*?^\s*port\s*=\s*(\d{2,5})/m)
    : name.startsWith('wrangler.')
      ? text.match(/"dev"\s*:\s*\{[^}]*"port"\s*:\s*(\d{2,5})/)
      : text.match(/\bport\s*:\s*(\d{2,5})/)
  return m ? Number(m[1]) : undefined
}

/** One app's port: a flag in its script, else its tool's config file, else the tool's default. */
export function appPort(body: string, configs: ReadonlyArray<{ name: string; text: string }>): number | undefined {
  const explicit = explicitPort(body)
  if (explicit !== undefined) return explicit
  for (const { name, text } of configs) {
    const tool = CONFIG_FILES.find(([file]) => file === name)?.[1]
    const port = tool?.test(body) ? configPort(name, text) : undefined
    if (port !== undefined) return port
  }
  return defaultPort(body)
}

/** Paths from `git worktree list --porcelain`. */
export function parseWorktrees(porcelain: string): string[] {
  return porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length).trim())
}

/** The worktree a path belongs to: the deepest one containing it (worktrees may nest in the main one). */
export function worktreeOf(path: string, worktrees: readonly string[]): string | undefined {
  return worktrees.filter(w => isUnder(path, w)).sort((a, b) => b.length - a.length)[0]
}
