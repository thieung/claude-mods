import { describe, expect, test } from 'claude-code/testing'

import {
  descendants,
  detectDevCommand,
  groupByPid,
  groupByRoot,
  parseListeners,
  parseMarkers,
  parsePs,
  shownPorts,
  portFromScript,
  rootOf,
} from '../hooks/detect'

describe('detectDevCommand', () => {
  const cwd = '/work/app'

  test('infers default ports per tool', () => {
    expect(detectDevCommand('npx vite', cwd)?.port).toBe(5173)
    expect(detectDevCommand('next dev', cwd)?.port).toBe(3000)
    expect(detectDevCommand('python3 -m http.server', cwd)?.port).toBe(8000)
    expect(detectDevCommand('vite preview', cwd)?.port).toBe(4173)
  })

  test('prefers an explicit port', () => {
    expect(detectDevCommand('vite --port 5175', cwd)?.port).toBe(5175)
    expect(detectDevCommand('PORT=4000 node server.js && next dev', cwd)?.port).toBe(4000)
    expect(detectDevCommand('python -m http.server 9001', cwd)?.port).toBe(9001)
  })

  test('defers npm scripts to package.json and follows cd', () => {
    expect(detectDevCommand('cd web && pnpm dev', cwd)).toEqual({ cwd: '/work/app/web', port: undefined, script: 'dev' })
    expect(portFromScript('astro dev --port 4400')).toBe(4400)
  })

  test('ignores text inside heredocs', () => {
    const script = "python3 - <<'EOF'\nprint('npx vite --port 5173')\nEOF\necho done"
    expect(detectDevCommand(script, cwd)).toBeUndefined()
    expect(detectDevCommand("cat > a.txt <<EOF\nnext dev\nEOF\nnext dev", cwd)?.port).toBe(3000)
  })

  test('ignores quoted text handed to other programs', () => {
    expect(detectDevCommand("printf '%s\\n' '(cd web && exec python3 -m http.server 5301) &' > dev.sh", cwd)).toBeUndefined()
    expect(detectDevCommand('grep -n "npm run dev" README.md', cwd)).toBeUndefined()
    expect(detectDevCommand('sh -c "npx vite --port 5180"', cwd)?.port).toBe(5180)
  })

  test('ignores builds and tests', () => {
    expect(detectDevCommand('vite build', cwd)).toBeUndefined()
    expect(detectDevCommand('npx vitest run', cwd)).toBeUndefined()
    expect(detectDevCommand('npm test', cwd)).toBeUndefined()
    expect(detectDevCommand('git status', cwd)).toBeUndefined()
  })
})

test('parseListeners reads lsof -F output', () => {
  const out = 'p101\ncnode\nn*:5173\nn[::1]:5173\np202\ncPython\nn127.0.0.1:8000\n'
  expect(parseListeners(out)).toEqual([
    { pid: 101, name: 'node', port: 5173 },
    { pid: 202, name: 'Python', port: 8000 },
  ])
})

test('groupByPid folds a multi-port process into one entry', () => {
  const list = [
    { pid: 7, name: 'workerd', port: 62411 },
    { pid: 7, name: 'workerd', port: 8787 },
    { pid: 7, name: 'workerd', port: 9229 },
    { pid: 9, name: 'node', port: 5173 },
  ]
  expect(groupByPid(list)).toEqual([
    { pid: 7, name: 'workerd', port: 8787, ports: [8787, 9229, 62411] },
    { pid: 9, name: 'node', port: 5173, ports: [5173] },
  ])
})

describe('process tree', () => {
  // turbo at the repo root runs the api app through pnpm, sh and wrangler; Claude
  // (50) runs mcp through its own shell; the person runs python in their terminal.
  const tree = parsePs(`
    50 1 claude
    60 50 /bin/zsh -c cd packages/mcp && npm run dev
    61 60 npm run dev
    62 61 node wrangler.js dev
    63 62 workerd serve
    100 99 node turbo run dev
    110 100 node pnpm run dev
    111 110 sh -c wrangler dev
    112 111 node wrangler.js dev
    113 112 workerd serve
    114 112 workerd serve
    70 1 -zsh
    71 70 python3 -m http.server
  `)
  const cwds = new Map([
    [50, '/repo'], [60, '/repo/packages/mcp'], [61, '/repo/packages/mcp'], [62, '/repo/packages/mcp'], [63, '/repo/packages/mcp'],
    [100, '/repo'], [110, '/repo/packages/api'], [111, '/repo/packages/api'], [112, '/repo/packages/api'],
    [113, '/repo/packages/api'], [114, '/repo/packages/api'], [70, '/repo'], [71, '/repo'],
  ])
  const stop = new Set([50])
  const root = (pid: number) => rootOf(pid, tree, cwds, stop)

  test('climbs to the app launcher sharing the working directory', () => {
    expect(root(113)).toBe(110)
    expect(root(114)).toBe(110)
  })

  test('never climbs into Claude or an interactive shell', () => {
    expect(root(63)).toBe(60)
    expect(root(71)).toBe(71)
  })

  test('folds every workerd of an app into one group', () => {
    const groups = groupByRoot(
      [
        { pid: 113, name: 'workerd', port: 9229, ports: [9229, 8787] },
        { pid: 114, name: 'workerd', port: 62411, ports: [62411] },
        { pid: 63, name: 'workerd', port: 1234, ports: [1234] },
      ],
      root,
    )
    expect(groups).toEqual([
      { root: 110, members: [113, 114], names: ['workerd', 'workerd'], ports: [8787, 9229, 62411], port: 8787 },
      { root: 60, members: [63], names: ['workerd'], ports: [1234], port: 1234 },
    ])
  })

  test('lists the whole app below its root', () => {
    expect(descendants(110, tree).sort()).toEqual([111, 112, 113, 114])
  })
})

test('shownPorts hides the internal ephemeral ports', () => {
  expect(shownPorts({ port: 8787, ports: [8787, 9229, 49154, 65471] })).toEqual([8787, 9229])
  expect(shownPorts({ port: 5173, ports: [5173] })).toEqual([5173])
})

test('parseMarkers reads the launching session from ps -E output', () => {
  const out = [
    '101 python3 -m http.server PATH=/bin GHOST_PROC_GUARD_SESSION=abc-1 HOME=/u',
    '102 node vite.js PATH=/bin HOME=/u',
  ].join('\n')
  expect([...parseMarkers(out)]).toEqual([[101, 'abc-1']])
})
