// What an agent changed, from git in its working directory.
import { execFile } from 'node:child_process'

export type Changes = { files: number; added: number; removed: number }

/** `git diff --shortstat HEAD` output, e.g. " 3 files changed, 120 insertions(+), 30 deletions(-)". */
export function parseShortstat(out: string): Changes {
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0)
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?\(\+\)/), removed: n(/(\d+) deletions?\(-\)/) }
}

/** Untracked files from `git status --porcelain`: lines starting "??". */
export function countUntracked(porcelain: string): number {
  return porcelain.split('\n').filter(l => l.startsWith('?? ')).length
}

export function describeChanges(c: Changes): string {
  if (!c.files) return 'no changes'
  return `+${c.added} −${c.removed} · ${c.files} file${c.files === 1 ? '' : 's'}`
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise(resolve =>
    // a repo's own config must not run anything: fsmonitor hooks are off, no index locks are taken
    execFile('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', cwd, ...args], { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? '' : stdout)),
  )
}

const branches = new Map<string, { at: number; value: string }>()

/** The checked-out branch in `cwd` ('' outside a repository or when detached). Cached briefly. */
export async function branchIn(cwd: string, now = Date.now()): Promise<string> {
  const hit = branches.get(cwd)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const value = (await git(cwd, ['branch', '--show-current'])).trim().slice(0, 100)
  branches.set(cwd, { at: now, value })
  return value
}

const cache = new Map<string, { at: number; value: Changes | null }>()
const CACHE_MS = 15_000

/** Changes in `cwd` against HEAD plus untracked files; null outside a repository. Cached briefly per cwd. */
export async function changesIn(cwd: string, now = Date.now()): Promise<Changes | null> {
  const hit = cache.get(cwd)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  let value: Changes | null = null
  if (inside) {
    const stat = parseShortstat(await git(cwd, ['diff', '--shortstat', 'HEAD']))
    const untracked = countUntracked(await git(cwd, ['status', '--porcelain']))
    value = { ...stat, files: stat.files + untracked }
  }
  cache.set(cwd, { at: now, value })
  return value
}

/** The room a session in `dir` lands in: the repository's main tree (worktrees included), else `dir` itself. */
export async function roomFor(dir: string): Promise<string> {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  if (common.endsWith('/.git')) return common.slice(0, -5)
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || dir
}
