import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  appPort,
  configPort,
  detectDevCommand,
  matchesFilters,
  parseFilters,
  workspaceGlobs,
  workspaceTask,
  worktreeOf,
} from '../hooks/detect'

describe('workspace runners', () => {
  test('recognise the task a runner starts', () => {
    expect(workspaceTask('turbo run dev')).toBe('dev')
    expect(workspaceTask('turbo dev --filter=web')).toBe('dev')
    expect(workspaceTask('pnpm -r dev')).toBe('dev')
    expect(workspaceTask('pnpm --filter @app/web dev')).toBe('dev')
    expect(workspaceTask('npm run dev --workspaces')).toBe('dev')
    expect(workspaceTask('turbo run build')).toBeUndefined()
    expect(detectDevCommand('cd wt && pnpm turbo run dev', '/r')).toEqual({ cwd: '/r/wt', task: 'dev' })
  })

  test('apply turbo filters by name or folder', () => {
    const f = parseFilters('turbo run dev --filter=!@app/docs --filter ./packages/web...')
    expect(f).toEqual({ include: ['./packages/web'], exclude: ['@app/docs'] })
    expect(matchesFilters('@app/web', 'packages/web', f)).toBe(true)
    expect(matchesFilters('@app/api', 'packages/api', f)).toBe(false)
    expect(matchesFilters('@app/docs', 'packages/docs', parseFilters('--filter=!@app/*'))).toBe(false)
  })

  test('read workspace globs from pnpm or package.json', () => {
    expect(workspaceGlobs('packages:\n  - "packages/*"\n  - apps/web\n  - "!**/test"\nother: 1\n', undefined)).toEqual(['packages/*', 'apps/web'])
    expect(workspaceGlobs(undefined, { workspaces: { packages: ['./apps/*'] } })).toEqual(['apps/*'])
  })

  test('pin ports from config files, else the tool default', () => {
    expect(configPort('vite.config.ts', 'export default { server: { port: 5199 } }')).toBe(5199)
    expect(configPort('wrangler.toml', 'name = "x"\n[dev]\nport = 8790\n')).toBe(8790)
    expect(configPort('wrangler.toml', 'name = "x"\n[vars]\nport = 1\n')).toBeUndefined()
    expect(appPort('vite', [{ name: 'vite.config.ts', text: 'server: { port: 5199 }' }])).toBe(5199)
    expect(appPort('wrangler dev', [])).toBe(8787)
    expect(appPort('wrangler dev --port 8788', [{ name: 'wrangler.toml', text: '[dev]\nport = 1\n' }])).toBe(8788)
    expect(appPort('astro dev', [{ name: 'vite.config.ts', text: 'port: 1' }])).toBe(4321)
  })

  test('place a path in the deepest worktree', () => {
    const trees = ['/repo', '/repo/.claude/worktrees/wt1']
    expect(worktreeOf('/repo/packages/web', trees)).toBe('/repo')
    expect(worktreeOf('/repo/.claude/worktrees/wt1/packages/web', trees)).toBe('/repo/.claude/worktrees/wt1')
  })
})

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const MAIN = '/repo'
const WT = '/repo/.claude/worktrees/wt1'

/** A turbo monorepo checked out twice: web pins 5173 in vite.config, api runs wrangler on its default 8787. */
function fakeRepo(on: On, sessionCwd: string, server: { cwd: string; port: number }) {
  const files: Record<string, string> = {}
  const dirs: Record<string, { name: string; kind: 'dir' | 'file' }[]> = {}
  for (const root of [MAIN, WT]) {
    files[`${root}/package.json`] = JSON.stringify({ scripts: { dev: 'turbo run dev' } })
    files[`${root}/pnpm-workspace.yaml`] = 'packages:\n  - "packages/*"\n'
    dirs[`${root}/packages`] = [{ name: 'web', kind: 'dir' }, { name: 'api', kind: 'dir' }]
    files[`${root}/packages/web/package.json`] = JSON.stringify({ name: '@app/web', scripts: { dev: 'vite' } })
    files[`${root}/packages/web/vite.config.ts`] = 'export default { server: { port: 5173 } }'
    dirs[`${root}/packages/web`] = [{ name: 'package.json', kind: 'file' }, { name: 'vite.config.ts', kind: 'file' }]
    files[`${root}/packages/api/package.json`] = JSON.stringify({ name: '@app/api', scripts: { dev: 'wrangler dev' } })
    dirs[`${root}/packages/api`] = [{ name: 'package.json', kind: 'file' }]
  }
  on('session.cwd', () => ({ value: sessionCwd }))
  on('session.id', () => ({ value: 's2' }))
  on('store.get', () => ({ value: [] }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }) as never)
  on('fs.list', ($, e) => ({ value: (dirs[e.path] ?? []).map(d => ({ ...d, size: 0 })) }) as never)
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'git') return ok(`worktree ${MAIN}\nHEAD abc\n\nworktree ${WT}\nHEAD abc\ndetached\n`)
    if (cmd === 'sh') return ok('50\n')
    if (cmd === 'lsof' && args.includes('-iTCP')) return ok(`p700\ncnode\nn127.0.0.1:${server.port}\n`)
    if (cmd === 'lsof' && args.includes('cwd')) return ok(`p700\nn${server.cwd}\n`)
    if (cmd === 'ps') return ok('50 1 claude\n700 1 node vite.js\n')
    return ok('')
  })
  const calls: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    calls.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return calls
}

test('a worktree launch is denied while the main checkout holds a port it needs', async ($, on) => {
  const calls = fakeRepo(on, WT, { cwd: `${MAIN}/packages/web`, port: 5173 })
  const denied = await $.tool.call({ tool: 'Bash', command: 'nohup pnpm dev > dev.log 2>&1 &' })
  const reason = String(denied.deny ?? denied.text)
  expect(calls).toEqual([])
  expect(reason).toContain('Port 5173 is already in use')
  expect(reason).toContain(`[another worktree: ${MAIN}]`)
  expect(reason).toContain('runs the code of another worktree')
  expect(reason).not.toContain('reuse it instead')
})

test('the main checkout is not blocked by a worktree serving on its own ports', async ($, on) => {
  const calls = fakeRepo(on, MAIN, { cwd: `${WT}/packages/web`, port: 5273 })
  await $.tool.call({ tool: 'Bash', command: 'pnpm dev' })
  expect(calls).toHaveLength(1)
})

test('the main checkout is denied when a worktree took one of its ports', async ($, on) => {
  const calls = fakeRepo(on, MAIN, { cwd: `${WT}/packages/api`, port: 8787 })
  const denied = await $.tool.call({ tool: 'Bash', command: 'pnpm dev' })
  expect(calls).toEqual([])
  expect(String(denied.deny ?? denied.text)).toContain(`[another worktree: ${WT}]`)
})
