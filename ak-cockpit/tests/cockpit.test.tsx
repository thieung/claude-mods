import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { forecast, shortTokens } from '../hooks/lib/context'
import { parseChecklist, planFromParse, planLine } from '../hooks/lib/plan'

const CWD = '/repo'

function parsed(name: string, phases: [number, string, number, number][]) {
  return JSON.stringify({
    data: {
      name, title: `${name} title`,
      total_tasks: phases.reduce((n, p) => n + p[3], 0), done_tasks: phases.reduce((n, p) => n + p[2], 0),
      phases: phases.map(([number, title, done, total]) => ({ number, title, done_tasks: done, total_tasks: total, file_path: `${CWD}/plans/${name}/phase-0${number}.md` })),
    },
  })
}

type World = { percent?: number; tokens?: number; toasts: string[]; commands: string[]; parses?: number; noPhases?: boolean; planMtime?: number }

const PHASE_2 = Array.from({ length: 30 }, (_, i) => `- [${i < 2 ? 'x' : ' '}] task ${i}`).join('\n')

/** Two plans on disk; `newer` has the later plan.md. */
function world(on: On, w: World) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...(w.percent === undefined ? {} : { percent: w.percent, tokens: w.tokens }), window: 200000 }, rateLimits: [] } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('fs.list', () => ({
    value: [
      { name: 'older', kind: 'dir' as const, size: 0, mtimeMs: 9, isLink: false },
      { name: 'newer', kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false },
      { name: 'reports', kind: 'dir' as const, size: 0, mtimeMs: 99, isLink: false },
    ],
  }))
  on('fs.stat', (_$, e) => {
    if (e.path.includes('reports')) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: 1, mtimeMs: e.path.includes('newer') ? (w.planMtime ?? 200) : 100, isLink: false } }
  })
  on('fs.read', () => ({ value: PHASE_2 }))
  on('process.run', (_$, e) => {
    w.parses = (w.parses ?? 0) + 1
    if (w.noPhases) return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: JSON.stringify({ data: { name: 'newer', title: 'newer title', total_tasks: 0, done_tasks: 0, phases: null } }) } }
    return { value: {
      exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      stdout: String(e.argv[3]).endsWith('/newer') ? parsed('newer', [[1, 'Scaffold', 3, 3], [2, 'Build', 2, 30], [3, 'Ship', 0, 4]]) : parsed('older', [[1, 'Old', 0, 1]]),
    } }
  })
  on('ui.toast', (_$, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.run', (_$, e) => { w.commands.push(e.command); return { text: '' } })
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const PANE = { title: 'plan', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 16 }, view: {} }

async function turn($: Engine, agentId?: string) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
}

describe('helpers', () => {
  test('plan view picks the first phase with open tasks', () => {
    const view = planFromParse(parsed('p', [[1, 'A', 2, 2], [2, 'B', 1, 3]]))
    expect(view?.current).toBe(1)
    expect(view && planLine(view)).toBe('▸ p · Phase 2/2 · 1/3 ☑')
    expect(planFromParse('not json')).toBe(null)
  })
  test('checklist reads both box states', () => {
    expect(parseChecklist('- [ ] a\n  - [x] b\ntext\n* [X] c')).toEqual([
      { isDone: false, text: 'a' }, { isDone: true, text: 'b' }, { isDone: true, text: 'c' },
    ])
  })
  test('forecast turns red at the threshold', () => {
    expect(forecast(74, 75).color).toBe('warning')
    expect(forecast(40, 75).color).toBeUndefined()
    expect(forecast(75, 75).glyph).toBe('↯')
    expect(shortTokens(4100)).toBe('+4.1k')
  })
})

describe('band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows context and the newest plan, no handoff below the threshold (${surface})`, async ($: Engine, on) => {
      const w: World = { percent: 40, tokens: 80000, toasts: [], commands: [] }
      world(on, w)
      await $.session.start({ cwd: CWD, surface, isInteractive: true })
      await turn($)
      const ui = await $.ui.mount({ plugin: 'ak-cockpit', surface, component: 'AbovePrompt', props: BAND })
      const text = (await ui.find({}))?.text ?? ''
      expect(text).toContain('Context 40%')
      expect(text).toContain('▸ newer · Phase 2/3 · 2/30 ☑')
      expect(text).toContain('engine band')
      expect(await ui.find({ key: 'handoff' })).toBeUndefined()
      expect(w.toasts.length).toBe(0)
      await ui.unmount()
    })
  }

  test('crossing the threshold toasts once and offers handoff', async ($: Engine, on) => {
    const w: World = { percent: 70, tokens: 140000, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($)
    w.percent = 78; w.tokens = 156000
    await turn($)
    w.percent = 80; w.tokens = 160000
    await turn($)
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toContain('/ak:handoff')
    for (const surface of ['terminal', 'desktop'] as const) {
      const hot = await $.ui.mount({ plugin: 'ak-cockpit', surface, component: 'AbovePrompt', props: BAND })
      expect((await hot.find({ type: 'Text', text: /Context 80%/ }))?.props.color).toBe('error')
      await hot.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'ak-cockpit', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await ui.find({}))?.text).toContain('(+4.0k)')
    await ui.press({ key: 'handoff' })
    expect(w.commands).toEqual(['ak:handoff'])
    await ui.unmount()
  })

  test('threshold comes from the plugin option', { options: { handoffPercent: 60 } }, async ($: Engine, on) => {
    const w: World = { percent: 65, tokens: 1, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($)
    expect(w.toasts.length).toBe(1)
  })
})

describe('plan pane', () => {
  test('lists phases and caps the open checklist', async ($: Engine, on) => {
    const w: World = { percent: 10, tokens: 1, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'ak-cockpit', surface: 'terminal', component: 'Pane', requestId: 'ak-cockpit-plan', props: PANE })
    const text = (await ui.find({}))?.text ?? ''
    expect(text).toContain('newer title')
    expect(text).toContain('✓ 1. Scaffold (3/3)')
    expect(text).toContain('▸ 2. Build (2/30)')
    expect(text).toContain('còn 28 mục')
    expect(text).toContain('☐ task 2')
    expect(text).not.toContain('☐ task 29')
    expect(text).toMatch(/… và \d+ mục khác/)
    await ui.unmount()
  })
})

describe('robustness', () => {
  test('an unchanged plan is parsed once', async ($: Engine, on) => {
    const w: World = { percent: 10, tokens: 1, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($)
    await turn($)
    expect(w.parses).toBe(1)
    w.planMtime = 300
    await turn($)
    expect(w.parses).toBe(2)
  })

  test('a subagent turn moves neither the reading nor the plan', async ($: Engine, on) => {
    const w: World = { percent: 80, tokens: 1, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($, 'agent-1')
    expect(w.toasts.length).toBe(0)
    expect(w.parses).toBe(1)
  })

  test('no reading after a compact clears the band and re-arms the warning', async ($: Engine, on) => {
    const w: World = { percent: 80, tokens: 160000, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($)
    w.percent = undefined
    await turn($)
    const ui = await $.ui.mount({ plugin: 'ak-cockpit', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await ui.find({}))?.text).not.toContain('Context')
    await ui.unmount()
    w.percent = 90; w.tokens = 180000
    await turn($)
    expect(w.toasts.length).toBe(2)
  })

  test('a plan without phases says so', async ($: Engine, on) => {
    const w: World = { percent: 10, tokens: 1, toasts: [], commands: [], noPhases: true }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'ak-cockpit', surface: 'terminal', component: 'Pane', requestId: 'ak-cockpit-plan', props: PANE })
    expect((await ui.find({}))?.text).toContain('chưa có phase')
    await ui.unmount()
  })

  test('an out-of-range threshold falls back to 75', { options: { handoffPercent: 0 } }, async ($: Engine, on) => {
    const w: World = { percent: 50, tokens: 1, toasts: [], commands: [] }
    world(on, w)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await turn($)
    expect(w.toasts.length).toBe(0)
  })
})
