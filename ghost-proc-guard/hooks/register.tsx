import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Proc } from '../types'
import {
  ancestors,
  appPort,
  CONFIG_FILES,
  descendants,
  detectDevCommand,
  groupByPid,
  groupByRoot,
  isUnder,
  matchesFilters,
  parseFilters,
  parseWorktrees,
  workspaceGlobs,
  workspaceTask,
  worktreeOf,
  MARKER,
  mainPort,
  parseCwds,
  parseListeners,
  parseMarkers,
  parsePs,
  resolvePath,
  rootOf,
  shownPorts,
  type DevCommand,
  type Group,
  type Tree,
} from './detect'

type Api = EngineInterface

const PANE = 'ghost-proc-guard'
const STORE_KEY = 'procs'
const BYPASS = /\bGHOST_PROC_GUARD=allow\b/
const SERVER_NAMES = /^(node|bun|deno|python\d?(\.\d+)?|ruby|php|java|go|uvicorn|gunicorn|workerd)/i
const PENDING_MS = 60_000

const tracked = atom({ plugin: 'ghost-proc-guard', key: 'tracked' } as const, [])
const others = atom({ plugin: 'ghost-proc-guard', key: 'others' } as const, [])
const pending = atom({ plugin: 'ghost-proc-guard', key: 'pending' } as const, [])

async function cwdsOf($: Api, pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  const out = await $.process.run(['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])
  return parseCwds(out.stdout)
}

/** pid -> the Claude session that launched it, read from the marker in its environment. */
async function markersOf($: Api, pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  return parseMarkers((await $.process.run(['ps', '-wwE', '-o', 'pid=,command=', '-p', pids.join(',')])).stdout)
}

/** The session a group was launched by, when any of its processes carries the marker. */
function launcherOf(g: Group, markers: ReadonlyMap<number, string>): string | undefined {
  return [g.root, ...g.members].map(pid => markers.get(pid)).find(Boolean)
}

/** Prefixes a launch so every process it starts carries this session's id. */
function marked(command: string, sessionId: string): string {
  return `export ${MARKER}=${sessionId}; ${command}`
}

async function processTree($: Api): Promise<Tree> {
  return parsePs((await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,command='])).stdout)
}

/** Claude's own process and everything above it: never climbed into, never stopped. */
async function selfChain($: Api, tree: Tree): Promise<Set<number>> {
  const self = Number((await $.process.run(['sh', '-c', 'echo $PPID'])).stdout.trim())
  return new Set(Number.isFinite(self) && self > 1 ? [self, ...ancestors(self, tree)] : [])
}

type Snapshot = {
  tree: Tree
  stop: Set<number>
  cwds: Map<number, string>
  groups: Group[]
  rootOf: (pid: number) => number
}

/** Listening processes folded into apps, plus what it took to fold them. `extra` pids get roots too. */
async function snapshot($: Api, extra: readonly number[] = []): Promise<Snapshot> {
  const [listening, tree] = await Promise.all([
    $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
    processTree($),
  ])
  const stop = await selfChain($, tree)
  const holders = groupByPid(parseListeners(listening.stdout)).filter(h => !stop.has(h.pid))
  const wanted = new Set<number>()
  for (const pid of [...holders.map(h => h.pid), ...extra.filter(pid => tree.has(pid))]) {
    wanted.add(pid)
    for (const up of ancestors(pid, tree, stop)) wanted.add(up)
  }
  const cwds = await cwdsOf($, [...wanted])
  const root = (pid: number) => rootOf(pid, tree, cwds, stop)
  return { tree, stop, cwds, groups: groupByRoot(holders, root), rootOf: root }
}

function appOf(snap: Snapshot, g: Group): { cwd: string; command: string } {
  return {
    cwd: snap.cwds.get(g.root) ?? snap.cwds.get(g.members[0]) ?? '',
    command: snap.tree.get(g.root)?.command ?? g.names[0] ?? '',
  }
}

/** Every live pid of the app: its root and all below it, Claude's chain excluded. */
function appPids(root: number, tree: Tree, stop: ReadonlySet<number>): number[] {
  return [root, ...descendants(root, tree)].filter(pid => tree.has(pid) && !stop.has(pid))
}

async function readText($: Api, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function readJson($: Api, path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText($, path)
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

async function listDir($: Api, path: string): Promise<{ name: string; kind: string }[]> {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

function scriptOf(pkg: Record<string, unknown> | undefined, name: string): string | undefined {
  const body = (pkg?.scripts as Record<string, unknown> | undefined)?.[name]
  return typeof body === 'string' && body.trim() !== '' ? body : undefined
}

/** The port one package's script will bind, reading its tool's config file when the script names none. */
async function packagePort($: Api, dir: string, body: string): Promise<number | undefined> {
  const present = new Set((await listDir($, dir)).map(entry => entry.name))
  const configs: { name: string; text: string }[] = []
  for (const [name, tool] of CONFIG_FILES) {
    if (!present.has(name) || !tool.test(body)) continue
    const text = await readText($, resolvePath(dir, name))
    if (text !== undefined) configs.push({ name, text })
  }
  return appPort(body, configs)
}

/** Package folders a workspace glob names (`packages/*`, `apps/web`); deeper globs are not expanded. */
async function expandGlob($: Api, root: string, glob: string): Promise<string[]> {
  if (!glob.includes('*')) return [resolvePath(root, glob)]
  const m = glob.match(/^([^*]*?)\/?\*$/)
  if (!m) return []
  const base = resolvePath(root, m[1] || '.')
  return (await listDir($, base)).filter(entry => entry.kind === 'dir').map(entry => resolvePath(base, entry.name))
}

/**
 * Every port a launch is expected to bind: the command's own, the script's,
 * or for a workspace runner one per package that runs the task.
 */
async function expectedPorts($: Api, dev: DevCommand, command: string): Promise<number[]> {
  if (dev.port !== undefined) return [dev.port]
  const rootPkg = await readJson($, resolvePath(dev.cwd, 'package.json'))
  let task = dev.task
  let runnerText = command
  if (task === undefined) {
    const body = dev.script ? scriptOf(rootPkg, dev.script) : undefined
    if (body === undefined) return []
    task = workspaceTask(body)
    if (task === undefined) {
      const port = await packagePort($, dev.cwd, body)
      return port === undefined ? [] : [port]
    }
    runnerText = `${body} ${command}`
  }

  const globs = workspaceGlobs(await readText($, resolvePath(dev.cwd, 'pnpm-workspace.yaml')), rootPkg)
  const filters = parseFilters(runnerText)
  const ports = new Set<number>()
  for (const glob of globs) {
    for (const dir of await expandGlob($, dev.cwd, glob)) {
      const pkg = await readJson($, resolvePath(dir, 'package.json'))
      const body = scriptOf(pkg, task)
      const name = typeof pkg?.name === 'string' ? pkg.name : undefined
      if (body === undefined || !matchesFilters(name, dir.slice(dev.cwd.length + 1), filters)) continue
      const port = await packagePort($, dir, body)
      if (port !== undefined) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

async function worktreesOf($: Api, cwd: string): Promise<string[]> {
  try {
    const out = await $.process.run(['git', '-C', cwd, 'worktree', 'list', '--porcelain'])
    return out.exitCode === 0 ? parseWorktrees(out.stdout) : []
  } catch {
    return []
  }
}

async function stored($: Api): Promise<Proc[]> {
  return ((await $.store.get(STORE_KEY)) as Proc[] | undefined) ?? []
}

function portsLabel(p: { port?: number; ports?: number[] }): string {
  const [main, ...rest] = shownPorts(p)
  return `port ${main ?? '?'}${rest.length > 0 ? ` (also ${rest.join(', ')})` : ''}`
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function earliest(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b)
}

async function persist($: Api, list: Proc[]): Promise<void> {
  await $.store.set(STORE_KEY, list)
  await update($, tracked, () => list)
  const running = list.filter(p => p.isAlive).length
  $.ui.status(running > 0 ? `procs: ${running} running · /procs` : undefined)
}

/** Cheap liveness pass for the timer: an app lives while its root or a listening member does. */
async function refreshAlive($: Api): Promise<void> {
  const tree = await processTree($)
  const list = await stored($)
  const next = list.map(p => ({ ...p, isAlive: [p.pid, ...(p.members ?? [])].some(pid => tree.has(pid)) }))
  if (next.some((p, i) => p.isAlive !== list[i].isAlive)) await persist($, next)
}

/**
 * Full pass: liveness, plus folding entries that belong to one app (records
 * kept per listening process by earlier versions, or a root seen late) into one.
 */
async function refreshTracked($: Api): Promise<Proc[]> {
  const list = await stored($)
  const snap = await snapshot($, list.flatMap(p => [p.pid, ...(p.members ?? [])]))
  const byRoot = new Map<number, Proc>()
  const dead: Proc[] = []

  for (const p of list) {
    const live = [p.pid, ...(p.members ?? [])].find(pid => snap.tree.has(pid))
    if (live === undefined) {
      if (!dead.some(d => d.pid === p.pid)) dead.push({ ...p, isAlive: false })
      continue
    }
    const root = snap.rootOf(live)
    const group = snap.groups.find(g => g.root === root)
    const seen = byRoot.get(root)
    const ports = [...new Set([...(seen?.ports ?? []), ...(group?.ports ?? p.ports ?? (p.port ? [p.port] : []))])].sort((a, b) => a - b)
    byRoot.set(root, {
      ...(seen ?? p),
      pid: root,
      members: group?.members ?? [...new Set([...(seen?.members ?? []), ...(p.members ?? [p.pid])])],
      ports,
      port: ports.length > 0 ? mainPort(ports) : p.port,
      cwd: snap.cwds.get(root) ?? p.cwd,
      startedAt: earliest(seen?.startedAt, p.startedAt),
      termSentAt: seen?.termSentAt ?? p.termSentAt,
      isAlive: true,
    })
  }

  const next = [...dead, ...byRoot.values()]
  await persist($, next)
  return next
}

async function refreshOthers($: Api): Promise<void> {
  const root = await $.session.root()
  const mine = await stored($)
  const known = new Set(mine.flatMap(p => [p.pid, ...(p.members ?? [])]))
  const snap = await snapshot($)
  const list: Proc[] = snap.groups
    .filter(g => !known.has(g.root) && !g.members.some(pid => known.has(pid)))
    .filter(g => g.names.some(name => SERVER_NAMES.test(name)))
    .map(g => ({ g, app: appOf(snap, g) }))
    .filter(({ app }) => isUnder(app.cwd, root))
    .map(({ g, app }) => ({ pid: g.root, members: g.members, port: g.port, ports: g.ports, command: app.command, cwd: app.cwd, isAlive: true }))
  await update($, others, () => list)
}

/** Turns pending launches into tracked apps as their listeners show up. */
async function settlePending($: Api): Promise<void> {
  const waiting = await read($, pending)
  if (waiting.length === 0) return
  const now = await $.clock.now()
  const snap = await snapshot($)
  const sessionId = await $.session.id()
  const list = await stored($)
  const byRoot = new Map(list.map(p => [p.pid, p]))
  const markers = await markersOf($, snap.groups.flatMap(g => [g.root, ...g.members]))
  const added: Proc[] = []
  let isChanged = false

  for (const job of waiting) {
    const before = new Set(job.before)
    for (const g of snap.groups) {
      const app = appOf(snap, g)
      const isNew = g.members.some(pid => !before.has(pid))
      const launcher = launcherOf(g, markers)
      const isOurs =
        launcher !== undefined
          ? launcher === sessionId
          : g.ports.some(p => (job.ports ?? [job.port]).includes(p)) || isUnder(app.cwd, job.cwd)
      if (!isNew || !isOurs) continue
      const seen = byRoot.get(g.root)
      if (seen === undefined) {
        const proc: Proc = {
          pid: g.root,
          members: g.members,
          port: g.port,
          ports: g.ports,
          command: job.command,
          cwd: app.cwd || job.cwd,
          sessionId,
          startedAt: now,
          isAlive: true,
        }
        byRoot.set(g.root, proc)
        added.push(proc)
      } else if (seen.sessionId === sessionId && g.ports.some(p => !(seen.ports ?? []).includes(p))) {
        byRoot.set(g.root, { ...seen, members: g.members, ports: g.ports, port: g.port })
        isChanged = true
      }
    }
  }

  // Monorepos start their apps at different speeds: keep watching each launch for its whole window.
  await update($, pending, () => waiting.filter(job => job.until > now))
  if (added.length > 0 || isChanged) await persist($, [...byRoot.values()])
  if (added.length > 0) {
    $.ui.toast(`ghost-proc-guard: tracking ${added.map(p => `:${p.port} (${shortPath(p.cwd)})`).join(', ')}`)
  }
}

/** Stops the whole app: TERM first, KILL on a second press while it lingers. */
async function stopApp($: Api, proc: Proc): Promise<void> {
  const tree = await processTree($)
  const self = await selfChain($, tree)
  const pids = [...new Set([...appPids(proc.pid, tree, self), ...(proc.members ?? []).filter(pid => tree.has(pid) && !self.has(pid))])]
  if (pids.length > 0) await $.process.run(['kill', proc.termSentAt ? '-KILL' : '-TERM', ...pids.map(String)])
  const list = await stored($)
  if (list.some(p => p.pid === proc.pid)) {
    const termSentAt = await $.clock.now()
    await persist($, list.map(p => (p.pid === proc.pid ? { ...p, termSentAt } : p)))
  }
  await $.clock.sleep(800)
  await refreshTracked($)
  await refreshOthers($)
}

async function forgetDead($: Api): Promise<void> {
  const list = await refreshTracked($)
  await persist($, list.filter(p => p.isAlive))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'procs',
      description: 'List dev servers started by Claude sessions and stop leftovers',
    })

    const list = await refreshTracked($)
    const root = await $.session.root()
    const sessionId = await $.session.id()
    const leftovers = list.filter(p => p.isAlive && p.sessionId !== sessionId && isUnder(p.cwd, root))
    if (leftovers.length > 0) {
      $.ui.toast(
        `ghost-proc-guard: ${leftovers.length} dev server(s) from earlier sessions still running here (${leftovers
          .map(p => `:${p.port}`)
          .join(', ')}). /procs to review.`,
      )
    }

    $.clock.every(3000, () => {
      void (async () => {
        await settlePending($)
        const current = await read($, tracked)
        if (current.some(p => p.isAlive)) await refreshAlive($)
      })()
    })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const dev = detectDevCommand(e.command, await $.session.cwd())
    if (!dev) return next(e)
    const sessionId = await $.session.id()
    if (BYPASS.test(e.command)) return next({ ...e, command: marked(e.command, sessionId) })

    const [ports, worktrees, snap] = await Promise.all([
      expectedPorts($, dev, e.command),
      worktreesOf($, dev.cwd),
      snapshot($),
    ])
    const here = worktreeOf(dev.cwd, worktrees)

    const onPort = snap.groups.filter(g => g.ports.some(p => ports.includes(p)))
    // A worktree nested in this folder (`.claude/worktrees/x`) is another checkout, not part of this launch's app.
    const sameDir = snap.groups.filter(g => {
      const cwd = appOf(snap, g).cwd
      return !onPort.includes(g) && g.names.some(name => SERVER_NAMES.test(name)) && isUnder(cwd, dev.cwd) && worktreeOf(cwd, worktrees) === here
    })

    if (onPort.length > 0 || sameDir.length > 0) {
      const mine = new Map((await stored($)).flatMap(p => [p.pid, ...(p.members ?? [])].map(pid => [pid, p] as const)))
      const busy = [...onPort, ...sameDir]
      const markers = await markersOf($, busy.flatMap(g => [g.root, ...g.members]))
      const lines = busy.map(g => {
        const app = appOf(snap, g)
        const pids = appPids(g.root, snap.tree, snap.stop)
        const owner = mine.get(g.root) ?? g.members.map(pid => mine.get(pid)).find(Boolean)
        const launcher = owner?.sessionId ?? launcherOf(g, markers)
        const who = launcher === sessionId ? 'this session' : `Claude session ${launcher?.slice(0, 8)}`
        const by = launcher ? ` (started by ${who})` : ''
        const tree = worktreeOf(app.cwd, worktrees)
        const elsewhere = tree !== undefined && tree !== here ? ` [another worktree: ${tree}]` : ''
        return `- ${app.command.slice(0, 120)} on ${portsLabel(g)} [cwd ${app.cwd || '?'}]${elsewhere}${by}; processes: ${pids.join(' ')}`
      })
      const isOtherWorktree = busy.some(g => {
        const tree = worktreeOf(appOf(snap, g).cwd, worktrees)
        return tree !== undefined && tree !== here
      })
      const taken = [...new Set(onPort.flatMap(g => g.ports.filter(p => ports.includes(p))))].sort((a, b) => a - b)
      return {
        deny: [
          `ghost-proc-guard: ${taken.length > 0 ? `Port${taken.length > 1 ? 's' : ''} ${taken.join(', ')} ${taken.length > 1 ? 'are' : 'is'} already in use.` : `A server is already listening from ${dev.cwd}.`} Not starting another dev server.`,
          ...lines,
          ...(isOtherWorktree
            ? [
                'That server runs the code of another worktree, so reusing it would test the wrong checkout.',
                'Ask the user whether to stop it, or give this worktree its own fixed ports (each app\'s port setting) instead of letting the tools pick a free one.',
              ]
            : []),
          ...(isOtherWorktree ? [] : ['Next step: if that server belongs to this project or worktree, reuse it instead of starting a new one or moving to another port.']),
          'If it is stale and this session started it, stop all of its processes (kill -TERM <processes>) and run the command again. If another session or the user owns it, ask the user before stopping it.',
          'If the user confirms a second server is really wanted, prefix the command with GHOST_PROC_GUARD=allow.',
        ].join('\n'),
      }
    }

    const ran = await next({ ...e, command: marked(e.command, sessionId) })
    const now = await $.clock.now()
    const listening = snap.groups.flatMap(g => g.members)
    await update($, pending, list => [
      ...list,
      { port: ports[0], ports, cwd: dev.cwd, command: e.command.slice(0, 200), before: listening, until: now + PENDING_MS },
    ])
    return ran
  })

  on('command.run', { command: 'procs' }, async $ => {
    await refreshTracked($)
    await refreshOthers($)
    await $.ui.open({ id: PANE, title: 'Dev processes' })
    return { text: 'Dev processes pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const sessionId = await $.session.id()
    const mine = await read($, tracked)
    const rest = await read($, others)
    const waiting = await read($, pending)

    const row = (p: Proc, tag: string) => {
      const [main, ...rest] = shownPorts(p)
      return (
        <Box key={`row-${p.pid}`} flexDirection="row" gap={1}>
          <Text color={p.isAlive ? 'green' : undefined} dimColor={!p.isAlive}>
            {p.isAlive ? '●' : '○'} :{main ?? '?'}
            {rest.length > 0 ? ` (${rest.map(x => `:${x}`).join(' ')})` : ''} pid {p.pid}
          </Text>
          <Text dimColor>
            {tag} {shortPath(p.cwd)}
          </Text>
          {p.isAlive && (
            <Button key={`stop-${p.pid}`} onPress={() => stopApp($, p)}>
              {p.termSentAt ? 'Kill' : 'Stop'}
            </Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Started by Claude</Text>
          {mine.length === 0 && <Text dimColor>None tracked yet.</Text>}
          {mine.map(p => row(p, p.sessionId === sessionId ? 'this session' : `session ${p.sessionId?.slice(0, 8) ?? '?'}`))}
          {waiting.length > 0 && <Text dimColor>Watching {waiting.length} launch(es) for new servers…</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Other servers in this project</Text>
          {rest.length === 0 && <Text dimColor>None.</Text>}
          {rest.map(p => row(p, 'untracked'))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" hotkey="r" onPress={async () => { await refreshTracked($); await refreshOthers($) }}>
            Refresh
          </Button>
          <Button key="forget" hotkey="f" onPress={() => forgetDead($)}>
            Forget stopped
          </Button>
        </Box>
      </Box>
    )
  })
}
