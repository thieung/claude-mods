import { expect, test } from 'claude-code/testing'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const APP = '/work/app/apps/web'

// Claude (50) launched `pnpm dev` through its shell (60): vite (61) listens, esbuild (62) is its child.
const TREE = [
  '50 1 claude',
  '60 50 /bin/zsh -c export GHOST_PROC_GUARD_SESSION=s1; cd apps/web && pnpm dev',
  '61 60 node vite.js',
  '62 61 esbuild --service',
  '63 1 node unrelated.js',
].join('\n')

test('Stop ends the whole app tree and never Claude itself', async ($, on) => {
  const kills: string[][] = []
  let store: unknown = [{ pid: 61, port: 5301, ports: [5301], command: 'pnpm dev', cwd: APP, sessionId: 's1', isAlive: true }]

  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({ value: store }))
  on('store.set', ($, e) => {
    store = e.value
    return { value: undefined }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'kill') kills.push(args)
    if (cmd === 'sh') return ok('50\n')
    if (cmd === 'ps' && args.includes('-A')) return ok(TREE)
    if (cmd === 'lsof' && args.includes('-iTCP')) return ok('p61\ncnode\nn127.0.0.1:5301\n')
    if (cmd === 'lsof' && args.includes('cwd')) {
      const pids = args[args.indexOf('-p') + 1].split(',')
      return ok(pids.map(p => `p${p}\nn${p === '50' ? '/work/app' : APP}\n`).join(''))
    }
    return ok('')
  })

  // Opening /procs folds the old per-process record (pid 61) into its app root (60).
  await $.command.run({ command: 'procs', args: '' })
  expect((store as { pid: number }[]).map(p => p.pid)).toEqual([60])

  const ui = await $.ui.mount({
    plugin: 'ghost-proc-guard',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ghost-proc-guard',
    props: { title: 'Dev processes', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect((await ui.find({ key: 'row-60' }))?.text).toContain(':5301')

  await ui.press({ key: 'stop-60' })
  expect(kills).toHaveLength(1)
  expect(kills[0][0]).toBe('-TERM')
  expect(kills[0].slice(1).map(Number).sort()).toEqual([60, 61, 62])
})
