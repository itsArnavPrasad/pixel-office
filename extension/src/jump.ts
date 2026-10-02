// Finding the integrated terminal a Claude session runs in, by process ancestry.
import { execFile } from 'node:child_process'

/** `ps -A -o pid=,ppid=` → child → parent. */
export function parsePs(out: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** The first ancestor of `pid` (itself included) that is a terminal's shell, within `depth` hops. */
export function shellAncestor(pid: number, shells: Set<number>, parents: Map<number, number>, depth = 12): number | null {
  let p: number | undefined = pid
  for (let i = 0; p && p > 1 && i <= depth; i++) {
    if (shells.has(p)) return p
    p = parents.get(p)
  }
  return null
}

export function processTree(): Promise<Map<number, number>> {
  return new Promise(resolve =>
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 3000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? new Map() : parsePs(out))),
  )
}

/** The executable a pid runs ('' when it is gone). */
export function commandOf(pid: number): Promise<string> {
  return new Promise(resolve =>
    execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 }, (err, out) => resolve(err ? '' : out.trim())),
  )
}
