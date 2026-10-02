// Reading other sessions' presence files and seating them.
import type { AgentRecord, AgentState } from '../../types'
import { presence } from './agent'
import { basename } from './text'

const STATES: AgentState[] = [
  'arriving', 'idle', 'thinking', 'typing', 'reading', 'writing', 'browsing',
  'delegating', 'working', 'needs-you', 'stressed', 'done', 'leaving',
]

const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Parses one presence file; anything malformed or foreign is `null`. */
export function parseRecord(text: string): AgentRecord | null {
  let r: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    r = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const ok =
    r.v === 1 && isStr(r.id, 100) && r.id.length > 0 && isStr(r.name, 100) && isStr(r.cwd, 4096) &&
    isStr(r.character, 50) && STATES.includes(r.state as AgentState) && isStr(r.bubble) &&
    typeof r.isBusy === 'boolean' && [r.joinedAt, r.since, r.heartbeat, r.turns, r.tools, r.interns].every(isNum) &&
    isStr(r.lastLine, 2000)
  if (!ok) return null
  // optional since 0.2: fill what an older mod did not write
  const pid = isNum(r.pid) ? r.pid : 0
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => isStr(f, 4096)).slice(0, 8) : []
  const room = isStr(r.room, 4096) && r.room ? r.room : (r.cwd as string)
  const roomName = isStr(r.roomName, 100) && r.roomName ? r.roomName : basename(room)
  const detail = isStr(r.detail) ? r.detail : ''
  return { ...(r as AgentRecord), pid, files, room, roomName, detail }
}

export type Seat = AgentRecord & { isAway: boolean; isMe: boolean }

/** Live roster from parsed files: pruned, deduped by id, own record wins. */
export function mergeRoster(records: (AgentRecord | null)[], me: AgentRecord | null, now: number): Seat[] {
  const byId = new Map<string, AgentRecord>()
  for (const r of records) if (r && (!byId.has(r.id) || byId.get(r.id)!.heartbeat < r.heartbeat)) byId.set(r.id, r)
  if (me) byId.set(me.id, { ...me, heartbeat: now })
  const seats: Seat[] = []
  for (const r of byId.values()) {
    const p = presence(r, now)
    if (p) seats.push({ ...r, isAway: p === 'away', isMe: r.id === me?.id })
  }
  return seats.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
}

/** 32-bit FNV-1a: a stable number per id, for desks and default looks. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/**
 * Desk per id: each id prefers desk hash(id) % count and probes forward, ids
 * seated in id order so the same set always lands the same way. Ids beyond
 * `count` get no desk (-1) and stand in the overflow row.
 */
export function assignDesks(ids: string[], count: number): Map<string, number> {
  const out = new Map<string, number>()
  const taken = new Set<number>()
  for (const id of [...new Set(ids)].sort()) {
    if (taken.size >= count) {
      out.set(id, -1)
      continue
    }
    let d = hash(id) % count
    while (taken.has(d)) d = (d + 1) % count
    taken.add(d)
    out.set(id, d)
  }
  return out
}
