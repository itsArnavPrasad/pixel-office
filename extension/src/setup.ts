// Turning the mod on for every Claude Code session: CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
const KEY = 'CLAUDE_CODE_PLUGIN_DIRS'

export type Edit = { text: string; changed: boolean } | { error: string }

type Parsed = { settings: Record<string, unknown> } | { error: string }

function parse(text: string): Parsed {
  if (!text.trim()) return { settings: {} }
  try {
    const v: unknown = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'settings.json is not a JSON object' }
    return { settings: v as Record<string, unknown> }
  } catch (err) {
    return { error: `settings.json is not valid JSON (${(err as Error).message}); it was left untouched` }
  }
}

function dirsOf(settings: Record<string, unknown>): { env: Record<string, unknown>; dirs: string[] } | { error: string } {
  const env = settings.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env) || env === null) return { error: '"env" in settings.json is not an object' }
  const cur = (env as Record<string, unknown>)[KEY]
  if (cur !== undefined && typeof cur !== 'string') return { error: `env.${KEY} is not a string` }
  return { env: env as Record<string, unknown>, dirs: (cur ?? '').split(':').filter(Boolean) }
}

/**
 * Adds `dir` to env.CLAUDE_CODE_PLUGIN_DIRS, keeping every other setting and directory. A value
 * the shell already sets (`shellDirs`) is carried in when settings has none, since the settings
 * env would replace it.
 */
export function addPluginDir(text: string, dir: string, shellDirs?: string): Edit {
  const p = parse(text)
  if ('error' in p) return p
  const s = p.settings
  const d = dirsOf(s)
  if ('error' in d) return d
  if (d.dirs.includes(dir)) return { text, changed: false }
  const base = d.dirs.length ? d.dirs : (shellDirs ?? '').split(':').filter(x => x && x !== dir)
  const env = { ...d.env, [KEY]: [...base, dir].join(':') }
  return { text: JSON.stringify({ ...s, env }, null, 2) + '\n', changed: true }
}

/** Removes `dir`; drops the variable (and an emptied env) when nothing is left. */
export function removePluginDir(text: string, dir: string): Edit {
  const p = parse(text)
  if ('error' in p) return p
  const s = p.settings
  const d = dirsOf(s)
  if ('error' in d) return d
  if (!d.dirs.includes(dir)) return { text, changed: false }
  const rest = d.dirs.filter(x => x !== dir)
  const env: Record<string, unknown> = { ...d.env }
  if (rest.length) env[KEY] = rest.join(':')
  else delete env[KEY]
  const next: Record<string, unknown> = { ...s, env }
  if (!Object.keys(env).length) delete next.env
  return { text: JSON.stringify(next, null, 2) + '\n', changed: true }
}

export function isEnabled(text: string, dir: string): boolean {
  const p = parse(text)
  if ('error' in p) return false
  const d = dirsOf(p.settings)
  return !('error' in d) && d.dirs.includes(dir)
}
