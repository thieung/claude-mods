/** One entry of `git status --porcelain=v1 -z`. */
export type StatusEntry = { path: string; isUntracked: boolean }

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all` output.
 * A rename or copy carries its source as a second NUL-separated field, which is skipped.
 */
export function parseStatus(out: string): StatusEntry[] {
  const fields = out.split('\0')
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    entries.push({ path: field.slice(3), isUntracked: code === '??' })
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return entries
}

/** Turns an absolute path inside `root` into a repo-relative one; null when it lies outside. */
export function toRepoPath(root: string, path: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  // macOS spells temp folders both ways; the repo root comes back resolved from git.
  if (path.startsWith('/tmp/') && prefix.startsWith('/private/tmp/')) return toRepoPath(root, `/private${path}`)
  return null
}

/** Splits touched files by who made them dirty. */
export function classify(touched: readonly string[], baseline: readonly string[], own: readonly string[]) {
  const before = new Set(baseline)
  const mine = new Set(own)
  const result = { foreign: [] as string[], unknown: [] as string[], mine: [] as string[] }
  for (const path of touched) {
    if (mine.has(path)) result.mine.push(path)
    else if (before.has(path)) result.foreign.push(path)
    else result.unknown.push(path)
  }
  return result
}

export type Group = { dir: string; count: number }

/** Groups paths by their first two directory levels, largest group first. */
export function groupByDir(paths: readonly string[]): Group[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    const dir = parts.length <= 1 ? './' : `${parts.slice(0, Math.min(2, parts.length - 1)).join('/')}/`
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
}

/** Quotes a path for a shell suggestion only when it needs it. */
export function shellQuote(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/** Resolves `.` and `..` in a repo-relative path; null when it climbs out of the repository. */
export function normalize(path: string): string | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/**
 * Keeps the paths a pathspec list covers, each spec read relative to `prefix`
 * (the command directory's place in the repo, `git rev-parse --show-prefix`).
 * An empty list covers the whole tree; magic and glob specs fall back to covering it too.
 */
export function underPathspecs(paths: readonly string[], prefix: string, specs: readonly string[]): string[] {
  if (!specs.length || specs.some(spec => spec.startsWith(':') || /[*?[]/.test(spec))) return [...paths]
  const roots = specs.map(spec => normalize(`${prefix}${spec}`)).filter((root): root is string => root !== null)
  return paths.filter(path => roots.some(root => root === '' || path === root || path.startsWith(`${root}/`)))
}

/** Expands `git clean -n` lines (repo-relative, directories ending in `/`) to the files status lists under them. */
export function expandDirs(removed: readonly string[], untracked: readonly string[]): string[] {
  const files = new Set<string>()
  for (const entry of removed) {
    if (!entry.endsWith('/')) {
      files.add(entry)
      continue
    }
    const inside = untracked.filter(path => path.startsWith(entry))
    if (inside.length) inside.forEach(path => files.add(path))
    else files.add(entry)
  }
  return [...files]
}
