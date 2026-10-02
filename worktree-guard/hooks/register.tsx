import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { busyPort, findGuarded, type GuardedCommand } from './lib/commands'
import { classify, expandDirs, groupByDir, normalize, parseStatus, shellQuote, toRepoPath, underPathspecs } from './lib/git-status'
import { lsofRecords, type Listener } from './lib/ports'

const PLUGIN = 'worktree-guard'
const PANE = 'worktree-guard'
/** Groups shown before the rest fold into one "and N more" row. */
const MAX_GROUPS = 8
const ALLOW = 'Vẫn chạy'
const DENY = 'Chặn lệnh'
/** Marks the state after a /clear: the next session.start adopts the new id and keeps the baseline. */
const KEEP = '*keep*'
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

const sessionId = atom({ plugin: 'worktree-guard', key: 'sessionId' } as const, null)
const root = atom({ plugin: 'worktree-guard', key: 'root' } as const, null)
const baseline = atom({ plugin: 'worktree-guard', key: 'baseline' } as const, [])
const own = atom({ plugin: 'worktree-guard', key: 'own' } as const, [])
const review = atom({ plugin: 'worktree-guard', key: 'review' } as const, null)
const isExpanded = atom({ plugin: 'worktree-guard', key: 'isExpanded' } as const, false)

/** Runs git with paths printed raw (no octal quoting of non-ASCII names); throws when git fails or its output was cut. */
async function git($: EngineInterface, args: string[], cwd: string): Promise<string> {
  const ran = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(`git ${args[0]} exited ${ran.exitCode}: ${ran.stderr.trim().slice(0, 200)}`)
  if (ran.isStdoutTruncated) throw new Error(`git ${args[0]} output was cut`)
  return ran.stdout
}

const statusOf = async ($: EngineInterface, top: string) =>
  parseStatus(await git($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], top))

const nulList = (out: string) => out.split('\0').filter(Boolean)

/** The repository a directory belongs to and its place in it; null when it is not inside one. */
async function locate($: EngineInterface, dir: string): Promise<{ top: string; prefix: string } | null> {
  const out = await git($, ['rev-parse', '--show-toplevel', '--show-prefix'], dir).catch(() => null)
  if (out === null) return null
  const [top = '', prefix = ''] = out.split('\n')
  return top ? { top, prefix } : null
}

/** The repo-relative files one guarded command would sweep in, shelve or throw away. */
async function touchedBy($: EngineInterface, top: string, prefix: string, dir: string, cmd: GuardedCommand): Promise<string[]> {
  switch (cmd.kind) {
    case 'stage': {
      const entries = (await statusOf($, top)).filter(x => !cmd.isTrackedOnly || !x.isUntracked)
      return underPathspecs(entries.map(x => x.path), prefix, cmd.paths)
    }
    case 'stash':
      return (await statusOf($, top)).filter(x => cmd.withUntracked || !x.isUntracked).map(x => x.path)
    case 'discard': {
      const spec = cmd.paths.length ? ['--', ...cmd.paths] : []
      return nulList(await git($, ['diff', '--name-only', '-z', ...(cmd.source ? [cmd.source] : []), ...spec], dir))
    }
    case 'clean': {
      const removed = (await git($, ['clean', '-n', ...cmd.args], dir))
        .split('\n')
        .map(line => line.match(/^Would remove (.+)$/)?.[1])
        .filter((path): path is string => path !== undefined)
        .map(path => {
          const rel = normalize(`${prefix}${path}`) ?? path
          return path.endsWith('/') ? `${rel}/` : rel
        })
      const untracked = (await statusOf($, top)).filter(x => x.isUntracked).map(x => x.path)
      return expandDirs(removed, untracked)
    }
  }
}

/** One question at a time: parallel tool calls each wait for the previous decision. */
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

type Decision = 'allow' | 'deny' | 'none'

/** Shows the review in the pane (the band stands in while the pane has no seat) and asks the person. */
function decide($: EngineInterface, held: Review, question: string): Promise<Decision> {
  return serially(async () => {
    await update($, isExpanded, () => false)
    await update($, review, () => held)
    try {
      await $.ui.open({ id: PANE, title: 'Worktree guard' }).catch(() => undefined)
      const answer = await $.ui.ask(question, { header: 'Worktree', options: [DENY, ALLOW] }).catch(() => null)
      return answer === ALLOW ? 'allow' : answer === null ? 'none' : 'deny'
    } finally {
      await update($, review, now => (now ? { ...now, isPending: false } : now)).catch(() => undefined)
      await $.ui.close({ id: PANE }).catch(() => undefined)
    }
  })
}

function summary(held: Review): string {
  const others = held.foreign.length + held.unknown.length
  if (held.kind === 'stage') {
    return `⚠ ${held.foreign.length} file lạ sẽ bị stage · ${held.unknown.length} chưa rõ · session này sửa ${held.mine.length}`
  }
  const total = others + held.mine.length
  const verb = held.kind === 'stash' ? 'sẽ bị cất vào stash' : 'sẽ mất thay đổi'
  return `⚠ ${total} file ${verb} · ${others} không do session này sửa`
}

function describeGroups(paths: readonly string[], count = 3): string {
  const groups = groupByDir(paths)
  const shown = groups.slice(0, count).map(g => `${g.dir} ${g.count}`).join(', ')
  return groups.length > count ? `${shown}, … ${groups.length - count} thư mục khác` : shown
}

/** First line of a command, cut to `max` characters, for one-line displays and deny texts. */
function shortCommand(command: string, max = 120): string {
  const first = command.split('\n')[0] ?? ''
  const cut = first.length > max ? `${first.slice(0, max - 1)}…` : first
  return command.includes('\n') ? `${cut} …` : cut
}

function fullList(held: Review): string {
  const block = (title: string, paths: readonly string[]) =>
    paths.length ? [`${title} (${paths.length}):`, ...paths.map(p => `  ${p}`)] : []
  return [
    `worktree-guard · ${shortCommand(held.command)}${held.isPending ? '' : ' (đã quyết định)'}`,
    ...block('Lạ — dirty từ trước session, session này không sửa', held.foreign),
    ...block('Chưa rõ — dirty trong session, không qua Edit/Write', held.unknown),
    ...block('Của session này', held.mine),
  ].join('\n')
}

/** Why the guard refused, worded for the model, which reads it as the tool's error. */
function denial(decision: Decision, what: string): string {
  const who = decision === 'none' ? 'no one answered the guard (dismissed, or a headless run with nobody to ask)' : 'the person chose to block it'
  return `${PLUGIN}: ${what}; ${who}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard-files', description: 'List every file the last guarded git command touched' }).catch(() => undefined)
    const id = await $.session.id()
    const stored = await read($, sessionId)
    await update($, review, () => null)
    if (stored === KEEP) {
      await update($, sessionId, () => id)
    } else if (stored !== id) {
      // A hot reload fires session.start again with the same id; only a new session takes a new baseline.
      const where = await locate($, e.cwd)
      const entries = where ? await statusOf($, where.top).catch(() => null) : null
      await update($, root, () => (where && entries ? where.top : null))
      await update($, baseline, () => (entries ?? []).map(x => x.path))
      await update($, own, () => [])
      await update($, sessionId, () => id)
      if (where && !entries) $.ui.toast('worktree-guard: không đọc được git status lúc mở session, guard tắt cho session này')
    }
    return next(e)
  })

  // Records the files this session writes, so a later `git add -A` can tell them from other sessions' work.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.includes(e.tool) || ran.deny !== undefined || ran.isError === true) return ran
    const top = await read($, root)
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    const rel = top && typeof path === 'string' ? toRepoPath(top, path) : null
    if (rel) await update($, own, list => (list.includes(rel) ? list : [...list, rel]))
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const top = await read($, root)
    const guarded = top ? findGuarded(e.command) : []
    const decided = new Set<string>()
    if (top && guarded.length) {
      const cwd = await $.session.cwd()
      for (const cmd of guarded) {
        const dir = cmd.dir.startsWith('/') ? cmd.dir : cmd.dir ? `${cwd}/${cmd.dir}` : cwd
        const where = await locate($, dir)
        // Another repository (a `cd ../other`, a worktree of its own) is not this baseline's business.
        if (!where || where.top !== top) continue
        const touched = await touchedBy($, top, where.prefix, dir, cmd)
        const key = [cmd.kind === 'stage' ? 'stage' : 'drop', ...[...touched].sort()].join('\0')
        if (touched.length === 0 || decided.has(key)) continue
        decided.add(key)
        const split = classify(touched, await read($, baseline), await read($, own))
        const kind = cmd.kind === 'stage' ? 'stage' : cmd.kind === 'stash' ? 'stash' : 'destructive'
        const held: Review = { kind, command: e.command, ...split, isPending: true }

        if (kind === 'stage') {
          if (split.foreign.length === 0) {
            if (split.unknown.length) {
              $.ui.toast(`worktree-guard: ${split.unknown.length} file chưa rõ nguồn sẽ được stage: ${describeGroups(split.unknown)}`)
            }
            continue
          }
          const decision = await decide($, held, `Lệnh này stage ${split.foreign.length} file session này không sửa (${describeGroups(split.foreign)}). Vẫn chạy?`)
          if (decision !== 'allow') {
            const suggestion = split.mine.length ? ` Stage only this session's files: git add ${split.mine.map(shellQuote).join(' ')}` : ''
            return { deny: denial(decision, `\`${shortCommand(e.command)}\` would stage ${split.foreign.length} file(s) this session did not edit (${describeGroups(split.foreign)}).${suggestion}`) }
          }
          continue
        }

        const others = split.foreign.length + split.unknown.length
        const action = kind === 'stash' ? 'cất vào stash' : 'bỏ thay đổi của'
        const decision = await decide($, held, `Lệnh này ${action} ${touched.length} file (${others} không do session này sửa: ${describeGroups([...split.foreign, ...split.unknown]) || 'không có'}). Vẫn chạy?`)
        if (decision !== 'allow') {
          return { deny: denial(decision, `\`${shortCommand(e.command)}\` would ${kind === 'stash' ? 'stash' : 'discard'} changes in ${touched.length} file(s) (${describeGroups(touched)})`) }
        }
      }
    }

    const ran = await next(e)
    try {
      const port = busyPort(ran.text ?? '')
      if (port !== null) {
        const owner = await portOwner($, port)
        $.ui.toast(owner ? `worktree-guard: port ${port} đang bị PID ${owner.pid} (${owner.name}) giữ, cwd ${owner.cwd}` : `worktree-guard: port ${port} đang bận`, { timeoutMs: 10000 })
      }
    } catch {
      // The command already ran; a failed port lookup must not fail the call.
    }
    return ran
  }).catch(($, e, next) => {
    // Fail closed: when the guard itself breaks before the command ran, a guarded command does not run.
    if (next.called || findGuarded(e.command).length === 0) return next(e)
    return { deny: `${PLUGIN}: could not check \`${shortCommand(e.command)}\` (${String(next.error).slice(0, 160)}), so it was blocked. Run it yourself if it is safe.` }
  })

  on('session.end', async ($, e, next) => {
    const top = await read($, root)
    if (e.reason === 'clear') await update($, sessionId, () => KEEP)
    if (top) {
      const listeners = await listenersIn($, top).catch(() => [])
      const lines = listeners.map(l => `PID ${l.pid} ${l.name} :${l.port}`)
      if (lines.length) $.ui.log(`worktree-guard: còn ${lines.length} process đang listen trong worktree: ${lines.join(', ')}`)
    }
    return next(e)
  })

  on('command.run', { command: 'guard-files' }, async $ => {
    const held = await read($, review)
    return { text: held ? fullList(held) : 'worktree-guard: chưa có lệnh git nào bị giữ trong session này.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const held = await read($, review)
    if (!held) return <Text dimColor>Không có lệnh nào đang chờ.</Text>
    const expanded = await read($, isExpanded)
    const others = [...held.foreign, ...held.unknown]
    const groups = groupByDir(held.kind === 'stage' ? held.foreign : others)
    const hidden = groups.length - MAX_GROUPS
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text key="summary" bold color="warning" wrap="truncate-end">{summary(held)}</Text>
        <Text key="command" dimColor wrap="truncate-middle">$ {shortCommand(held.command)}</Text>
        <Box key="actions" gap={1}>
          <Button key="expand" label={expanded ? 'Thu gọn' : 'Xem hết'} onPress={() => update($, isExpanded, v => !v)} />
        </Box>
        {expanded ? (
          fullList(held).split('\n').slice(1).map((line, i) => <Text key={`line-${i}`} wrap="truncate-middle">{line}</Text>)
        ) : (
          <Box key="groups" flexDirection="column">
            {groups.slice(0, MAX_GROUPS).map(g => (
              <Text key={`group-${g.dir}`} wrap="truncate-middle">  {g.dir} ({g.count})</Text>
            ))}
            {hidden > 0 && <Text key="more" dimColor>  … và {hidden} thư mục khác</Text>}
            {held.kind === 'stage' && held.unknown.length > 0 && <Text key="unknown" dimColor>  + {held.unknown.length} file chưa rõ nguồn</Text>}
          </Box>
        )}
        {held.kind === 'stage' && held.mine.length > 0 && (
          <Text key="suggest" bold wrap="truncate-end">→ git add {held.mine.map(shellQuote).join(' ')}</Text>
        )}
      </Box>
    )
  })

  // While the pane has no seat (a narrow terminal), the band above the prompt carries one line instead.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const held = await read($, review)
    if (!held?.isPending || e.props.hasSurvey) return below
    const isSeated = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (isSeated) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text key="guard" color="warning" wrap="truncate-end">{summary(held)} · /guard-files để xem hết</Text>
        {below}
      </Box>
    )
  })
}

async function lsof($: EngineInterface, args: string[]): Promise<string> {
  const ran = await $.process.run(['lsof', '-nP', ...args], { timeoutMs: 5000 }).catch(() => null)
  return ran?.stdout ?? ''
}

async function cwdOf($: EngineInterface, pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  if (!pids.length) return map
  for (const rec of lsofRecords(await lsof($, ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']))) {
    if (rec.names[0]) map.set(rec.pid, rec.names[0])
  }
  return map
}

/** The process listening on `port`, with its working directory. */
async function portOwner($: EngineInterface, port: number): Promise<Listener | null> {
  const rec = lsofRecords(await lsof($, [`-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn']))[0]
  if (!rec) return null
  const cwd = (await cwdOf($, [rec.pid])).get(rec.pid) ?? '?'
  return { pid: rec.pid, name: rec.name, port, cwd }
}

/** Every listening process whose working directory lies inside `top`, with each of its ports. */
async function listenersIn($: EngineInterface, top: string): Promise<Listener[]> {
  const records = lsofRecords(await lsof($, ['-iTCP', '-sTCP:LISTEN', '-Fpcn']))
  const cwds = await cwdOf($, [...new Set(records.map(r => r.pid))])
  const prefix = `${top.replace(/\/$/, '')}/`
  return records.flatMap(rec => {
    const cwd = cwds.get(rec.pid)
    if (!cwd || (cwd !== top && !cwd.startsWith(prefix))) return []
    const ports = [...new Set(rec.names.map(n => Number(n.match(/:(\d+)$/)?.[1] ?? 0)).filter(Boolean))]
    return ports.map(port => ({ pid: rec.pid, name: rec.name, port, cwd }))
  })
}
