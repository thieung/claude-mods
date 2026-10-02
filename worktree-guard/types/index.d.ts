/** A git command the guard holds for the person's decision. */
export type Review = {
  /** `stage`: an add/commit that sweeps files in; `stash`: one that shelves changes; `destructive`: one that discards them. */
  kind: 'stage' | 'stash' | 'destructive'
  /** The command as the model wrote it. */
  command: string
  /** Files the command touches that were dirty before this session began and that it never edited. */
  foreign: string[]
  /** Files the command touches that became dirty during the session without an Edit or Write from it. */
  unknown: string[]
  /** Files the command touches that this session edited. */
  mine: string[]
  /** True while the person is being asked; the last review stays readable by /guard-files after. */
  isPending: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-guard': {
      /** The session the baseline belongs to, so a hot reload keeps it; `KEEP` after a /clear. */
      sessionId: string | null
      /** The repository root, or null outside a git repository. */
      root: string | null
      /** Repo-relative paths that were dirty when the session started. */
      baseline: string[]
      /** Repo-relative paths this session wrote through Edit, Write or NotebookEdit. */
      own: string[]
      /** The command waiting on the person, or the last one decided. */
      review: Review | null
      /** Whether the pane lists every file instead of the grouped summary. */
      isExpanded: boolean
    }
  }
}
