export type Listener = { pid: number; name: string; port: number; cwd: string }

/** Parses `lsof -F` field output into one record per process. */
export function lsofRecords(out: string): { pid: number; name: string; names: string[] }[] {
  const records: { pid: number; name: string; names: string[] }[] = []
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') records.push({ pid: Number(value), name: '', names: [] })
    const last = records[records.length - 1]
    if (!last) continue
    if (tag === 'c') last.name = value
    if (tag === 'n') last.names.push(value)
  }
  return records
}
