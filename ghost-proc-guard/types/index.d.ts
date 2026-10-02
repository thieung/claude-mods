export type Proc = {
  pid: number
  port?: number
  /** Every port the process listens on, sorted; `port` is the first. */
  ports?: number[]
  /** The processes of the app that listen on its ports; `pid` is the app's root. */
  members?: number[]
  command: string
  cwd: string
  sessionId?: string
  startedAt?: number
  isAlive: boolean
  termSentAt?: number
}

export type Pending = {
  port?: number
  /** Every port the launch is expected to bind (one per app of a monorepo). */
  ports?: number[]
  cwd: string
  command: string
  before: number[]
  until: number
}

declare module 'claude-code' {
  interface PluginState {
    'ghost-proc-guard': { tracked: Proc[]; others: Proc[]; pending: Pending[] }
  }
}
