// Standup: one request, every session answers from its own transcript.
import type { StandupAnswer, StandupRequest } from '../../types'
import { clean, truncate } from './text'

export const ANSWER_WINDOW_MS = 5 * 60 * 1000 // a session answers requests this fresh
export const SHOW_MS = 10 * 60 * 1000 // a pane shows a standup this long
export const PENDING_MS = 90 * 1000 // after this, a missing answer is "(no answer)"
export const TURN_MS = 5000 // each presenter holds the floor this long
export const KEEP_MS = 60 * 60 * 1000 // files older than this are swept

export const STANDUP_PROMPT = `Standup time. Report on the work in this conversation so far, for a teammate glancing at a dashboard.
Answer with exactly three lines and nothing else:
Done: <what you finished, at most 12 words>
Next: <what you are doing or will do next, at most 12 words>
Blocked: <what you need from the user, or "nothing">`

const LINE = 100

export type Report = { done: string; next: string; blocked: string }

/** Reads the model's three lines; tolerates bullets, bold, odd casing and missing lines. */
export function parseReport(text: string): Report {
  const out: Report = { done: '', next: '', blocked: '' }
  const loose: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*\-•\d.)]+/, '').replace(/\*\*|__|`/g, '').trim()
    const m = /^(done|next|blocked|blockers?)\s*[:\-–]\s*(.*)$/i.exec(line)
    if (m) {
      const key = m[1]!.toLowerCase().startsWith('block') ? 'blocked' : (m[1]!.toLowerCase() as 'done' | 'next')
      if (!out[key]) out[key] = truncate(clean(m[2]!), LINE)
    } else if (line) loose.push(line)
  }
  if (!out.done && !out.next && loose.length) out.done = truncate(clean(loose.join(' ')), LINE)
  if (/^(nothing|none|no|n\/a|-)\.?$/i.test(out.blocked)) out.blocked = ''
  return out
}

const ID = /^\d{13}-[0-9a-z]{6}$/
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

export function makeRequest(id: string, by: string, now: number): StandupRequest {
  return { v: 1, id, by, requestedAt: now }
}

function json(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseRequest(text: string): StandupRequest | null {
  const r = json(text)
  return r && r.v === 1 && isStr(r.id, 20) && ID.test(r.id) && isStr(r.by, 100) && typeof r.requestedAt === 'number'
    ? (r as StandupRequest)
    : null
}

export function parseAnswer(text: string): StandupAnswer | null {
  const r = json(text)
  const ok =
    r && r.v === 1 && isStr(r.id, 100) && r.id.length > 0 && isStr(r.name, 100) && isStr(r.character, 50) &&
    isStr(r.done, LINE + 5) && isStr(r.next, LINE + 5) && isStr(r.blocked, LINE + 5) && typeof r.at === 'number'
  return ok ? (r as StandupAnswer) : null
}

/** The newest request file name (`<id>.json`) still inside `windowMs`, by id time. */
export function latestRequest(names: string[], now: number, windowMs: number): string | null {
  const ids = names.filter(n => n.endsWith('.json') && ID.test(n.slice(0, -5))).map(n => n.slice(0, -5)).sort()
  const id = ids.at(-1)
  return id && now - Number(id.slice(0, 13)) <= windowMs ? id : null
}

/** Who presents now: answers take TURN_MS turns in answer order, then wrap. */
export function presenter(answers: StandupAnswer[], startedAt: number, now: number): string | null {
  if (!answers.length) return null
  const order = [...answers].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const turn = Math.floor(Math.max(0, now - startedAt) / TURN_MS) % order.length
  return order[turn]!.id
}

/** What a presenter's bubble says. */
export function headline(a: StandupAnswer): string {
  if (a.blocked) return `Blocked: ${a.blocked}`
  return a.done ? `Done: ${a.done}` : a.next ? `Next: ${a.next}` : 'Nothing to report.'
}
