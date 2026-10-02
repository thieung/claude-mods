/** The context window's fill after the last turn. */
export type ContextReading = {
  /** Whole percent of the window in use. */
  percent: number
  /** Input tokens the last response was answered over. */
  tokens: number
  /** Change in tokens since the turn before. */
  delta: number
}

/** One checkbox line of a phase file. */
export type ChecklistItem = { text: string; isDone: boolean }

/** A plan phase as `ak plan parse` reports it. */
export type PhaseView = { number: number; title: string; status: string; doneTasks: number; totalTasks: number; file: string }

/** The plan the band follows: the one whose plan.md changed last. */
export type PlanView = {
  name: string
  title: string
  doneTasks: number
  totalTasks: number
  phases: PhaseView[]
  /** Index into `phases` of the first phase still open; -1 when all are done or there are none. */
  current: number
  /** The checklist of the current phase, read with the plan so the two never disagree. */
  checklist: ChecklistItem[]
  /** plan.md's directory and mtime, so an unchanged plan is not parsed again. */
  dir: string
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'ak-cockpit': {
      context: ContextReading | null
      /** True once the threshold toast fired for the current crossing. */
      isWarned: boolean
      plan: PlanView | null
    }
  }
}
