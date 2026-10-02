// One session's character: a pure reducer from session signals to its record.
import type { AgentRecord, AgentState } from '../../types'
import { activityFor } from './signals'
import { basename, bubble, clean, firstSentence, taskOf, truncate } from './text'

export type Signal =
  | { kind: 'start'; name: string; cwd: string; character: string; pid?: number; room?: string; roomName?: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; tool: string; input?: Record<string, unknown> }
  | { kind: 'tool-done'; isError: boolean }
  | { kind: 'needs-you'; text: string }
  | { kind: 'turn-done'; text: string; reason?: 'answer' | 'aborted' | 'refusal' | 'error' }
  | { kind: 'interns'; delta: number }
  | { kind: 'title'; text: string }
  | { kind: 'end' }
  | { kind: 'tick' }

export const HOLD_MS = 3000 // stressed / arriving show this long; done stays until the next prompt
export const AWAY_MS = 20000 // no heartbeat this long → away
export const PRUNE_MS = 10 * 60 * 1000 // no heartbeat this long → gone

const EDITS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const MAX_FILES = 8

function editedPath(input: Record<string, unknown> = {}): string {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p.startsWith('/') && p.length <= 4096 ? p : ''
}

const WORKING: AgentState[] = ['thinking', 'typing', 'reading', 'writing', 'browsing', 'delegating', 'working']

export function isWorking(state: AgentState): boolean {
  return WORKING.includes(state)
}

export function newAgent(id: string, now: number): AgentRecord {
  return {
    v: 1, id, name: 'claude', cwd: '', character: 'dev-1', state: 'arriving', bubble: 'Morning!', detail: '',
    isBusy: false, joinedAt: now, since: now, heartbeat: now, turns: 0, tools: 0, interns: 0, lastLine: '', pid: 0, files: [], room: '', roomName: '', task: '', title: '',
  }
}

export function reduce(a: AgentRecord, s: Signal, now: number): AgentRecord {
  const to = (state: AgentState, text = a.bubble, extra: Partial<AgentRecord> = {}): AgentRecord =>
    ({ ...a, state, bubble: text, since: state === a.state && text === a.bubble ? a.since : now, heartbeat: now, ...extra })

  switch (s.kind) {
    case 'start':
      // a restart or hot reload keeps the arrival time, so seniority is stable
      return { ...newAgent(a.id, now), name: s.name, cwd: s.cwd, character: s.character, turns: a.turns, tools: a.tools, joinedAt: a.joinedAt || now, pid: s.pid ?? a.pid ?? 0, files: a.files ?? [],
        room: s.room || s.cwd, roomName: s.roomName || basename(s.cwd), task: a.task ?? '', title: a.title ?? '' }
    case 'prompt':
      return to('thinking', bubble(s.text), { isBusy: true, turns: a.turns + 1, task: taskOf(s.text) || a.task || '' })
    case 'title':
      return { ...a, title: truncate(clean(s.text), 80) }
    case 'tool': {
      const act = activityFor(s.tool, s.input)
      const path = EDITS.includes(s.tool) ? editedPath(s.input) : ''
      const files = path ? [path, ...(a.files ?? []).filter(f => f !== path)].slice(0, MAX_FILES) : a.files ?? []
      return to(act.state, act.bubble, { isBusy: true, tools: a.tools + 1, files, detail: act.detail })
    }
    case 'tool-done':
      if (s.isError) return to('stressed', 'Hmm, that failed…')
      // a tool ending answers a pending question or permission, so needs-you clears
      return a.state === 'needs-you' || isWorking(a.state) ? to('thinking', a.state === 'needs-you' ? 'Thanks!' : a.bubble) : a
    case 'needs-you':
      // a permission prompt raises this twice (the request, then its notification): keep the first
      // wording and the time the wait started
      return a.state === 'needs-you' ? { ...a, heartbeat: now } : to('needs-you', bubble(s.text || 'I need you'))
    case 'turn-done': {
      if (s.reason === 'aborted') return to('idle', 'Stopped.', { isBusy: false })
      if (s.reason === 'error') return to('stressed', 'That turn failed.', { isBusy: false })
      const line = firstSentence(s.text)
      return to('done', bubble(line || 'Done!'), { isBusy: false, lastLine: line || a.lastLine })
    }
    case 'interns':
      return { ...a, interns: Math.max(0, a.interns + s.delta), heartbeat: now }
    case 'end':
      return to('leaving', 'Bye!', { isBusy: false, interns: 0 })
    case 'tick': {
      const held = now - a.since >= HOLD_MS
      if (held && a.state === 'arriving') return { ...to('idle', ''), heartbeat: now }
      if (held && a.state === 'stressed') return { ...to(a.isBusy ? 'thinking' : 'idle', a.isBusy ? a.bubble : ''), heartbeat: now }
      return { ...a, heartbeat: now }
    }
  }
}

/** What others see: a stale heartbeat is `away`; `null` means prune it. */
export function presence(a: AgentRecord, now: number): 'here' | 'away' | null {
  const age = now - a.heartbeat
  if (age > PRUNE_MS || (a.state === 'leaving' && age > HOLD_MS)) return null
  return age > AWAY_MS ? 'away' : 'here'
}

const RANK: Record<AgentState, number> = {
  'needs-you': 0, stressed: 1, typing: 2, reading: 2, writing: 2, browsing: 2, delegating: 2, working: 2,
  thinking: 3, done: 4, arriving: 5, idle: 6, leaving: 7,
}

/** Roster order for chips: who needs you first, then busiest, then by name. */
export function byUrgency(a: AgentRecord, b: AgentRecord): number {
  return RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}
