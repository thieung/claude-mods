import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { busyPort, findGuarded } from '../hooks/lib/commands'
import { classify, expandDirs, groupByDir, parseStatus, underPathspecs } from '../hooks/lib/git-status'

const ROOT = '/repo'

type World = {
  /** Porcelain entries, e.g. ' M a.ts' or '?? b.md'. */
  status: string[]
  answer?: string
  asked: string[]
  toasts: string[]
  logs: string[]
  gitCalls: string[][]
  lsof?: Record<string, string>
  /** Directories git knows, mapped to [toplevel, prefix]; anything else is "not a repository". */
  repos?: Record<string, [string, string]>
  /** git subcommands that fail. */
  failing?: string[]
  isPlaced?: boolean
  /** Every argv the plugin ran. */
  raw?: string[][]
  /** Text the engine itself draws in the band, beneath the plugin. */
  beneath?: string
  onAsk?: () => Promise<void>
}

const result = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false } })

/** Stands in for git, lsof and the engine's UI beneath the plugin. */
function world(on: On, w: World) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', () => ({ value: { command: 'guard-files' } }))
  on('ui.open', () => ({ value: w.isPlaced === false ? { isPlaced: false as const, reason: 'narrow' as never } : { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [{ id: 'worktree-guard', title: 'Worktree guard', isShown: true, isFocused: false, isPlaced: w.isPlaced !== false }] as never }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return w.beneath ? <Text>{w.beneath}</Text> : <Box />
  })
  on('ui.toast', (_$, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', (_$, e) => { w.logs.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const [cmd, ...rest] = e.argv
    w.raw?.push([...e.argv])
    if (cmd === 'lsof') return result(w.lsof?.[rest.join(' ')] ?? '')
    const args = rest[0] === '-c' ? rest.slice(2) : rest
    w.gitCalls.push(args)
    const verb = args[0] ?? ''
    if (w.failing?.includes(verb)) return result('', 128)
    const cwd = e.init?.cwd ?? ROOT
    const tracked = w.status.filter(s => !s.startsWith('??')).map(s => s.slice(3))
    switch (verb) {
      case 'rev-parse': {
        const repo = (w.repos ?? { [ROOT]: [ROOT, ''] })[cwd]
        return repo ? result(`${repo[0]}\n${repo[1]}\n`) : result('', 128)
      }
      case 'status': return result(w.status.map(s => `${s}\0`).join(''))
      case 'diff': return result(tracked.map(p => `${p}\0`).join(''))
      case 'clean': return result(w.status.filter(s => s.startsWith('??')).map(s => `Would remove ${s.slice(3).split('/')[0]}/\n`).join(''))
      default: return result('')
    }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    await w.onAsk?.()
    const question = e.questions[0]?.question ?? ''
    w.asked.push(question)
    if (w.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: w.answer } } }
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const out = e.command.includes('dev') ? '12:34:56 Error: listen EADDRINUSE: address already in use :::3000' : ''
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out }
  })
}

const fresh = (over: Partial<World> = {}): World => ({ status: [], asked: [], toasts: [], logs: [], gitCalls: [], ...over })
const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

describe('command recognition', () => {
  const kinds = (cmd: string) => findGuarded(cmd).map(g => g.kind)
  test('stage forms', () => {
    expect(findGuarded('cd a && git add -A && git commit -m x')).toEqual([{ kind: 'stage', isTrackedOnly: false, paths: [], dir: 'a' }])
    expect(findGuarded('git commit -am "msg"')[0]).toMatchObject({ kind: 'stage', isTrackedOnly: true })
    expect(findGuarded('git -C /repo/web add -A')[0]).toMatchObject({ kind: 'stage', dir: '/repo/web' })
    expect(findGuarded('git -c core.x=1 --no-pager add .')[0]).toMatchObject({ kind: 'stage', paths: ['.'] })
    expect(findGuarded('git add -A src')[0]).toMatchObject({ kind: 'stage', paths: ['src'] })
    expect(kinds('(git add -A)')).toEqual(['stage'])
    expect(kinds('FOO=1 /usr/bin/git add -A')).toEqual(['stage'])
    expect(kinds('git add src/a.ts')).toEqual([])
  })
  test('text that only mentions git is not a command', () => {
    const commit = "git commit -m \"$(cat <<'EOF'\nfix: avoid git add -A in shared trees\n\ngit reset --hard is dangerous\nEOF\n)\""
    expect(kinds(commit)).toEqual([])
    expect(kinds('cat > s.sh <<EOF\ngit reset --hard\nEOF')).toEqual([])
    expect(kinds('echo git add -A')).toEqual([])
    expect(kinds('git commit -m "run git add -A; then push"')).toEqual([])
  })
  test('stash, checkout, restore, reset, switch', () => {
    expect(findGuarded('git stash -m "wip"')[0]).toMatchObject({ kind: 'stash', withUntracked: false })
    expect(findGuarded('git stash push -u')[0]).toMatchObject({ kind: 'stash', withUntracked: true })
    expect(kinds('git stash list')).toEqual([])
    expect(kinds('git stash pop')).toEqual([])
    expect(findGuarded('git checkout .')[0]).toMatchObject({ kind: 'discard', paths: ['.'] })
    expect(findGuarded('git checkout HEAD -- f')[0]).toMatchObject({ kind: 'discard', source: 'HEAD', paths: ['f'] })
    expect(kinds('git checkout main')).toEqual([])
    expect(findGuarded('git checkout -f main')[0]).toMatchObject({ kind: 'discard', source: 'HEAD' })
    expect(kinds('git switch --discard-changes main')).toEqual(['discard'])
    expect(kinds('git restore --staged a.ts')).toEqual([])
    expect(kinds('git restore -S a.ts')).toEqual([])
    expect(findGuarded('git restore -SW a.ts')[0]).toMatchObject({ kind: 'discard', source: 'HEAD', paths: ['a.ts'] })
    expect(findGuarded('git restore -s main f')[0]).toMatchObject({ source: 'main', paths: ['f'] })
    expect(findGuarded('git reset --hard HEAD~1')[0]).toMatchObject({ kind: 'discard', source: 'HEAD~1', paths: [] })
  })
  test('clean previews with the same scope and never drops a quiet or exclude flag on the floor', () => {
    expect(findGuarded('git clean -fdx build')[0]).toMatchObject({ kind: 'clean', args: ['-dx', 'build'] })
    expect(findGuarded('git clean -fdq')[0]).toMatchObject({ kind: 'clean', args: ['-d'] })
    expect(findGuarded('git clean -fd -e node_modules')[0]).toMatchObject({ args: ['-d', '-e', 'node_modules'] })
    expect(findGuarded('git clean -fdenode_modules')[0]).toMatchObject({ args: ['-d', '-e', 'node_modules'] })
    expect(findGuarded('git clean --force --exclude=dist -d')[0]).toMatchObject({ args: ['--exclude=dist', '-d'] })
    expect(kinds('git clean -n')).toEqual([])
    expect(kinds('git clean -fdn')).toEqual([])
  })
  test('busy port', () => {
    expect(busyPort('12:34:56 Error: listen EADDRINUSE: address already in use :::3000')).toBe(3000)
    expect(busyPort('OSError: [Errno 48] Address already in use (port 8000)')).toBe(8000)
    expect(busyPort("src/x.ts:42: if (e.code === 'EADDRINUSE')")).toBe(null)
    expect(busyPort('all good on :3000')).toBe(null)
  })
})

describe('path helpers', () => {
  test('parses porcelain -z, skipping a rename source', () => {
    expect(parseStatus(' M a.ts\0R  new.ts\0old.ts\0?? docs/hướng.md\0')).toEqual([
      { path: 'a.ts', isUntracked: false },
      { path: 'new.ts', isUntracked: false },
      { path: 'docs/hướng.md', isUntracked: true },
    ])
  })
  test('classifies by baseline and own edits', () => {
    expect(classify(['a', 'b', 'c'], ['a', 'b'], ['b'])).toEqual({ foreign: ['a'], unknown: ['c'], mine: ['b'] })
  })
  test('groups by two directory levels, largest first', () => {
    expect(groupByDir(['x/y/1', 'x/y/z/2', 'x/q', 'top.md'])).toEqual([
      { dir: 'x/y/', count: 2 }, { dir: './', count: 1 }, { dir: 'x/', count: 1 },
    ])
  })
  test('pathspecs read relative to the command directory', () => {
    const all = ['web/a.ts', 'web/b/c.ts', 'api/d.ts', 'top.md']
    expect(underPathspecs(all, 'web/', ['.'])).toEqual(['web/a.ts', 'web/b/c.ts'])
    expect(underPathspecs(all, 'web/', ['../api'])).toEqual(['api/d.ts'])
    expect(underPathspecs(all, '', [])).toEqual(all)
    expect(underPathspecs(all, '', ['*.md'])).toEqual(all)
  })
  test('clean directories expand to the files inside them', () => {
    expect(expandDirs(['gen/', 'x.log'], ['gen/a.js', 'gen/b/c.js', 'other/z'])).toEqual(['gen/a.js', 'gen/b/c.js', 'x.log'])
  })
})

describe('stage guard', () => {
  test('denies git add -A over files dirty before the session, and suggests own files', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts', '?? other/b.md'] })
    world(on, w)
    await start($)
    w.status.push(' M src/mine.ts')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/mine.ts`, old_string: 'a', new_string: 'b' })
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(w.asked.length).toBe(1)
    expect(w.asked[0]).toContain('other/ 2')
    expect(ran.deny).toContain('2 file(s) this session did not edit')
    expect(ran.deny).toContain('git add src/mine.ts')
    expect(ran.deny).toContain('no one answered')
  })

  test('lets it run when the person says so, and asks once for a repeated set', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'], answer: 'Vẫn chạy' })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -am x' })
    expect(ran.deny).toBeUndefined()
    expect(w.asked.length).toBe(1)
  })

  test('words the refusal as the person\'s when they chose to block', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'], answer: 'Chặn lệnh' })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add .' })
    expect(ran.deny).toContain('the person chose to block it')
  })

  test('only warns about files of unknown origin', async ($, on) => {
    const w = fresh()
    world(on, w)
    await start($)
    w.status.push('?? gen/out.js')
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(w.asked.length).toBe(0)
    expect(ran.deny).toBeUndefined()
    expect(w.toasts[0]).toContain('1 file chưa rõ nguồn')
  })

  test('git add -A of a path stages only under it', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'] })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A src' })
    expect(w.asked.length).toBe(0)
    expect(ran.deny).toBeUndefined()
  })

  test('leaves other repositories alone', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'], repos: { [ROOT]: [ROOT, ''], '/elsewhere': ['/elsewhere', ''] } })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'cd /elsewhere && git add -A' })
    expect(w.asked.length).toBe(0)
    expect(ran.deny).toBeUndefined()
  })

  test('runs every git call with raw paths', async ($, on) => {
    const raw: string[][] = []
    const w = fresh({ status: [' M a.ts'], raw })
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(raw.length).toBeGreaterThan(2)
    expect(raw.filter(a => a[0] === 'git').every(a => a[1] === '-c' && a[2] === 'core.quotePath=false')).toBe(true)
  })
})

describe('fail closed', () => {
  test('a git failure while checking blocks a guarded command', async ($, on) => {
    const w = fresh({ status: [' M a.ts'] })
    world(on, w)
    await start($)
    w.failing = ['diff']
    const ran = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(ran.deny).toContain('could not check')
  })

  test('an unguarded command still runs when nothing can be checked', async ($, on) => {
    const w = fresh({ status: [' M a.ts'] })
    world(on, w)
    await start($)
    w.failing = ['status', 'diff', 'rev-parse']
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(ran.deny).toBeUndefined()
  })

  test('a baseline that cannot be read turns the guard off with a notice', async ($, on) => {
    const w = fresh({ failing: ['status'] })
    world(on, w)
    await start($)
    expect(w.toasts[0]).toContain('guard tắt')
  })
})

describe('session lifecycle', () => {
  test('a hot reload keeps the baseline and own edits', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'] })
    world(on, w)
    await start($)
    w.status.push(' M src/mine.ts')
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/mine.ts`, old_string: 'a', new_string: 'b' })
    await start($)
    w.answer = 'Chặn lệnh'
    const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(ran.deny).toContain('1 file(s) this session did not edit')
  })

  test('/guard-files lists the last decided command', async ($, on) => {
    const w = fresh({ status: [' M other/a.ts'], answer: 'Chặn lệnh' })
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    const out = await $.command.run({ command: 'guard-files', args: '' } as never)
    expect(out.text).toContain('other/a.ts')
    expect(out.text).toContain('đã quyết định')
  })
})

describe('destructive preview', () => {
  test('asks before git reset --hard and denies when dismissed', async ($, on) => {
    const w = fresh({ status: [' M a.ts', ' M b/c.ts'] })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(w.asked[0]).toContain('2 file')
    expect(ran.deny).toContain('discard changes in 2 file(s)')
  })

  test('git clean -fdq is previewed, not waved through', async ($, on) => {
    const w = fresh({ status: ['?? gen/a.js', '?? gen/b.js'] })
    world(on, w)
    await start($)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git clean -fdq' })
    expect(w.asked[0]).toContain('2 file')
    expect(ran.deny).toBeDefined()
  })

  test('stash says the changes are shelved', async ($, on) => {
    const w = fresh({ status: [' M a.ts'] })
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git stash -m wip' })
    expect(w.asked[0]).toContain('cất vào stash')
  })
})

describe('ports', () => {
  test('names the process holding a busy port', async ($, on) => {
    const w = fresh({
      lsof: {
        '-nP -iTCP:3000 -sTCP:LISTEN -Fpcn': 'p4242\ncnode\nf10\nn*:3000\n',
        '-nP -a -d cwd -p 4242 -Fpn': 'p4242\nfcwd\nn/repo/web\n',
      },
    })
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
    expect(w.toasts[0]).toContain('port 3000')
    expect(w.toasts[0]).toContain('PID 4242 (node)')
    expect(w.toasts[0]).toContain('/repo/web')
  })

  test('lists listeners inside the worktree at session end', async ($, on) => {
    const w = fresh({
      lsof: {
        '-nP -iTCP -sTCP:LISTEN -Fpcn': 'p1\ncnode\nn*:3000\nn*:3001\np2\ncpostgres\nn*:5432\n',
        '-nP -a -d cwd -p 1,2 -Fpn': 'p1\nn/repo\np2\nn/usr/local\n',
      },
    })
    world(on, w)
    await start($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { sessionId: 's1' } as never })
    expect(w.logs[0]).toContain('PID 1 node :3000, PID 1 node :3001')
    expect(w.logs[0]).not.toContain('postgres')
  })
})

const PANE_PROPS = (bodyColumns: number) => ({
  title: 'Worktree guard', isFocused: false, bodyColumns, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 }, view: {},
})
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} }

/** Twenty directories of strangers' files. */
const crowded = () => Array.from({ length: 20 }, (_, i) => `?? area${i}/sub/file${i}.ts`)

describe('pane and band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`pane caps the groups at eight and expands on press (${surface})`, async ($: Engine, on) => {
      const seen = { collapsed: '', expanded: '' }
      const w = fresh({ status: crowded(), answer: 'Chặn lệnh' })
      w.onAsk = async () => {
        const ui = await $.ui.mount({ plugin: 'worktree-guard', surface, component: 'Pane', requestId: 'worktree-guard', props: PANE_PROPS(60) })
        seen.collapsed = (await ui.find({}))?.text ?? ''
        await ui.press({ key: 'expand' })
        seen.expanded = (await ui.find({}))?.text ?? ''
        await ui.unmount()
      }
      world(on, w)
      await $.session.start({ cwd: ROOT, surface, isInteractive: true })
      const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
      expect(ran.deny).toContain('20 file(s)')
      expect(seen.collapsed).toContain('20 file lạ')
      expect(seen.collapsed).toContain('… và 12 thư mục khác')
      expect(seen.collapsed).not.toContain('area19/sub/file19.ts')
      expect(seen.expanded).toContain('area19/sub/file19.ts')
    })
  }

  test('band carries one line when the pane gets no seat, and keeps what is drawn beneath', async ($: Engine, on) => {
    let band = ''
    const w = fresh({ status: crowded(), isPlaced: false, beneath: 'engine band' })
    w.onAsk = async () => {
      const ui = await $.ui.mount({ plugin: 'worktree-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
      band = (await ui.find({ text: /file lạ/ }))?.text ?? ''
      expect((await ui.find({}))?.text).toContain('engine band')
      await ui.unmount()
    }
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(band).toContain('20 file lạ')
    expect(band).toContain('/guard-files')
  })

  test('band stays out of the way when the pane is seated', async ($: Engine, on) => {
    let drawn = 'unset'
    const w = fresh({ status: crowded() })
    w.onAsk = async () => {
      const ui = await $.ui.mount({ plugin: 'worktree-guard', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
      drawn = (await ui.find({}))?.text ?? ''
      await ui.unmount()
    }
    world(on, w)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git add -A' })
    expect(drawn).not.toContain('file lạ')
    expect(drawn).not.toBe('unset')
  })
})
