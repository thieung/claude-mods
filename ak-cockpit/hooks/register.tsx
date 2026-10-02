import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanView } from '../types'
import { forecast, shortTokens } from './lib/context'
import { parseChecklist, planFromParse, planLine } from './lib/plan'

const PANE = 'ak-cockpit-plan'
const HANDOFF = 'ak:handoff'
/** Rows the pane's body spends besides the phase list and the open items: title, totals, the "còn" line, the overflow line. */
const PANE_FIXED_ROWS = 4

const context = atom({ plugin: 'ak-cockpit', key: 'context' } as const, null)
const isWarned = atom({ plugin: 'ak-cockpit', key: 'isWarned' } as const, false)
const plan = atom({ plugin: 'ak-cockpit', key: 'plan' } as const, null)

/** The plan directory under `plans/` whose plan.md was written last, with that mtime. */
async function newestPlan($: EngineInterface): Promise<{ dir: string; mtimeMs: number } | null> {
  const base = `${(await $.session.cwd()).replace(/\/$/, '')}/plans`
  const entries = await $.fs.list(base).catch(() => [])
  let best: { dir: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const dir = `${base}/${entry.name}`
    const stat = await $.fs.stat(`${dir}/plan.md`).catch(() => null)
    if (stat && (!best || stat.mtimeMs > best.mtimeMs)) best = { dir, mtimeMs: stat.mtimeMs }
  }
  return best
}

/** Rereads the plan when plan.md moved; always rereads the current phase's checklist, which changes on its own. */
async function refreshPlan($: EngineInterface): Promise<void> {
  const found = await newestPlan($)
  if (!found) {
    await update($, plan, () => null)
    return
  }
  const last = await read($, plan)
  let base: Omit<PlanView, 'checklist' | 'dir' | 'mtimeMs'> | null = last && last.dir === found.dir && last.mtimeMs === found.mtimeMs ? last : null
  if (!base) {
    const ran = await $.process.run(['ak', 'plan', 'parse', found.dir, '--json'], { timeoutMs: 10000 }).catch(() => null)
    base = ran && ran.exitCode === 0 ? planFromParse(ran.stdout) : null
  }
  if (!base) {
    await update($, plan, () => null)
    return
  }
  const phase = base.phases[base.current]
  const text = phase ? await $.fs.read(phase.file).catch(() => '') : ''
  const checklist = parseChecklist(typeof text === 'string' ? text : '')
  const view: PlanView = { ...base, checklist, dir: found.dir, mtimeMs: found.mtimeMs }
  await update($, plan, () => view)
}

async function refreshContext($: EngineInterface, threshold: number): Promise<void> {
  const usage = (await $.session.usage()).context
  if (usage.percent === undefined || usage.tokens === undefined) {
    // Right after a compact or /clear there is no reading yet: drop the old one rather than show it.
    await update($, context, () => null)
    await update($, isWarned, () => false)
    return
  }
  const percent = usage.percent
  const tokens = usage.tokens
  const last = await read($, context)
  await update($, context, () => ({ percent, tokens, delta: last ? tokens - last.tokens : 0 }))
  if (percent >= threshold && !(await read($, isWarned))) {
    await update($, isWarned, () => true)
    $.ui.toast(`Context ${percent}% — nên chạy /${HANDOFF} trước khi bị compact`, { timeoutMs: 8000 })
  } else if (percent < threshold) {
    // A compact brings it back under; the next crossing warns again.
    await update($, isWarned, () => false)
  }
}

export const register: Register = (on, options) => {
  const asked = Number(options.handoffPercent)
  const threshold = Number.isFinite(asked) && asked >= 1 && asked <= 100 ? Math.round(asked) : 75

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refreshPlan($).catch(() => undefined)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's turn says nothing about the main window, and would refresh the plan once per agent.
    if (e.agentId !== undefined) return done
    await refreshContext($, threshold).catch(() => undefined)
    await refreshPlan($).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const reading = await read($, context)
    const view = await read($, plan)
    if (!reading && !view) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const weather = reading ? forecast(reading.percent, threshold) : null
    const isHot = reading !== null && reading.percent >= threshold
    const handoff = () =>
      $.command.run({ command: HANDOFF }).catch(() => $.ui.toast(`Không chạy được /${HANDOFF}: skill chưa được cài?`))
    return (
      <Box flexDirection="column">
        <Box key="cockpit" gap={2} width={e.props.bodyColumns}>
          {reading && weather && (
            <Box key="context" gap={1} flexShrink={0}>
              <Text key="reading" color={weather.color} bold={isHot}>
                {weather.glyph} Context {reading.percent}% ({shortTokens(reading.delta)}) · handoff ở {threshold}%
              </Text>
              {isHot && <Button key="handoff" label="Handoff" variant="primary" onPress={handoff} />}
            </Box>
          )}
          {view && <Button key="plan" plain label={planLine(view)} onPress={() => $.ui.open({ id: PANE, title: view.title })} />}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    if (!view) return <Text dimColor>Không tìm thấy plan nào trong plans/.</Text>
    if (!view.phases.length) return <Text dimColor>{view.title}: plan chưa có phase nào.</Text>
    const open = view.checklist.filter(item => !item.isDone)
    const room = Math.max(3, e.props.scroll.bodyRows - view.phases.length - PANE_FIXED_ROWS)
    const shown = open.length > room ? room - 1 : open.length
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text key="title" bold wrap="truncate-end">{view.title}</Text>
        <Text key="totals" dimColor>{view.doneTasks}/{view.totalTasks} task xong</Text>
        {view.phases.map((phase, i) => (
          <Text key={`phase-${phase.number}`} color={i === view.current ? 'cyan' : undefined} dimColor={i !== view.current && phase.doneTasks === phase.totalTasks} wrap="truncate-end">
            {i === view.current ? '▸' : i < view.current || view.current < 0 ? '✓' : ' '} {phase.number}. {phase.title} ({phase.doneTasks}/{phase.totalTasks})
          </Text>
        ))}
        {view.current >= 0 && <Text key="open" bold>Phase {view.phases[view.current]?.number} — còn {open.length} mục:</Text>}
        {open.slice(0, shown).map((item, i) => <Text key={`item-${i}`} wrap="truncate-end">  ☐ {item.text}</Text>)}
        {open.length > shown && <Text key="overflow" dimColor>  … và {open.length - shown} mục khác</Text>}
      </Box>
    )
  })
}
