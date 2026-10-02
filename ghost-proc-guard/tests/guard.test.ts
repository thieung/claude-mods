import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** Fakes the host: one python server (pid 4242) listening on :8000 from `cwd`. */
const CWD = '/work/app'

function fakeHost(on: On, cwd: string) {
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'lsof' && args.includes('-iTCP')) return ok('p4242\ncPython\nn127.0.0.1:8000\n')
    if (cmd === 'lsof' && args.includes('cwd')) return ok(`p4242\nn${cwd}\n`)
    if (cmd === 'ps') return ok('4242 1 /usr/bin/python3 -m http.server\n')
    if (cmd === 'sh') return ok('999\n')
    return ok('')
  })
}

function fakeBash(on: On) {
  const calls: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    calls.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return calls
}

test('denies a dev server on a port that is already held', async ($, on) => {
  fakeHost(on, '/somewhere/else')
  const calls = fakeBash(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'python3 -m http.server' })
  expect(calls).toEqual([])
  expect(denied.deny ?? denied.text).toContain('Port 8000 is already in use')
  expect(denied.deny ?? denied.text).toContain('processes: 4242')
})

test('denies a second server from the same directory on another port', async ($, on) => {
  fakeHost(on, CWD)
  const calls = fakeBash(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'python3 -m http.server 8001' })
  expect(calls).toEqual([])
  expect(denied.deny ?? denied.text).toContain('A server is already listening from')
})

test('denies a monorepo dev run while a child app already serves', async ($, on) => {
  fakeHost(on, `${CWD}/apps/web`)
  const calls = fakeBash(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'python3 -m http.server 8001' })
  expect(calls).toEqual([])
  expect(denied.deny ?? denied.text).toContain('A server is already listening from')
})

test('lets the bypass and free ports through', async ($, on) => {
  fakeHost(on, '/somewhere/else')
  const calls = fakeBash(on)

  await $.tool.call({ tool: 'Bash', command: 'GHOST_PROC_GUARD=allow python3 -m http.server' })
  await $.tool.call({ tool: 'Bash', command: 'npx vite --port 5199' })
  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(calls).toHaveLength(3)
  // Launches carry the session marker so their processes can be told apart later; other commands run as typed.
  expect(calls[0]).toMatch(/^export GHOST_PROC_GUARD_SESSION=\S+; GHOST_PROC_GUARD=allow python3/)
  expect(calls[1]).toMatch(/^export GHOST_PROC_GUARD_SESSION=\S+; npx vite --port 5199$/)
  expect(calls[2]).toBe('echo hi')
})

test('names a multi-port process once in the deny reason', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'lsof' && args.includes('-iTCP')) return ok('p77\ncworkerd\nn127.0.0.1:62411\nn127.0.0.1:8787\nn127.0.0.1:9229\n')
    if (cmd === 'lsof' && args.includes('cwd')) return ok(`p77\nn${CWD}/packages/api\n`)
    if (cmd === 'ps') return ok('77 1 workerd serve\n')
    if (cmd === 'sh') return ok('999\n')
    return ok('')
  })
  fakeBash(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'pnpm dev' })
  const reason = String(denied.deny ?? denied.text)
  expect(reason).toContain('on port 8787 (also 9229) [')
  expect(reason.split('processes: 77')).toHaveLength(2)
})
