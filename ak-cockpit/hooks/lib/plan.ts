import type { ChecklistItem, PhaseView, PlanView } from '../../types'

type ParsedPhase = { number: number; title: string; status?: string; total_tasks: number; done_tasks: number; file_path: string }
type Parsed = { data: { name: string; title: string; total_tasks: number; done_tasks: number; phases: ParsedPhase[] | null } }

const DONE = new Set(['done', 'completed', 'complete'])

/** A phase is open while it has unchecked tasks, or, with none counted, until its status says done. */
export const isOpen = (p: PhaseView) => (p.totalTasks > 0 ? p.doneTasks < p.totalTasks : !DONE.has(p.status))

/** Turns `ak plan parse --json` output into the band's view, checklist and source left empty; null when it does not parse. */
export function planFromParse(json: string): Omit<PlanView, 'checklist' | 'dir' | 'mtimeMs'> | null {
  let parsed: Parsed
  try {
    parsed = JSON.parse(json) as Parsed
  } catch {
    return null
  }
  const data = parsed?.data
  if (!data || typeof data.name !== 'string') return null
  const phases: PhaseView[] = (data.phases ?? []).map(p => ({
    number: p.number,
    title: p.title,
    status: p.status ?? '',
    doneTasks: p.done_tasks,
    totalTasks: p.total_tasks,
    file: p.file_path,
  }))
  return {
    name: data.name,
    title: data.title,
    doneTasks: data.done_tasks,
    totalTasks: data.total_tasks,
    phases,
    current: phases.findIndex(isOpen),
  }
}

/** Reads the `- [ ]` and `- [x]` lines of a markdown file. */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  for (const match of markdown.matchAll(/^\s*[-*] \[([ xX])\] (.+)$/gm)) {
    items.push({ isDone: match[1] !== ' ', text: (match[2] ?? '').trim() })
  }
  return items
}

/** One-line summary: `▸ name · Phase 3/5 · 7/12 ☑`. */
export function planLine(plan: Pick<PlanView, 'name' | 'phases' | 'current'>): string {
  if (!plan.phases.length) return `▸ ${plan.name} · chưa có phase`
  const phase = plan.phases[plan.current]
  if (!phase) return `▸ ${plan.name} · xong ${plan.phases.length}/${plan.phases.length} phase`
  return `▸ ${plan.name} · Phase ${phase.number}/${plan.phases.length} · ${phase.doneTasks}/${phase.totalTasks} ☑`
}
