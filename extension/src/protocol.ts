// Messages between the webview and the extension. Webview input is untrusted: validate before acting.
import type { Seat } from '../../pixel-office/hooks/core/roster'
import type { Standup } from '../../pixel-office/types'
import type { Collision } from './collisions'
import type { Entry, PlanItem } from './transcript'

export type Insight = { changes?: string; tokens?: string; where?: string; hasTranscript?: boolean }
export type RoomView = { id: string; name: string; branch?: string; seatIds: string[]; waiting: number }

export type ViewState = {
  type: 'view'
  now: number
  seats: Seat[]
  rooms: RoomView[]
  queue: string[]
  standup: Standup | null
  collisions: Collision[]
  insights: Record<string, Insight>
  selected: string | null
  /** The selected agent's live conversation, newest last. */
  chat: { id: string; entries: Entry[]; task: string; plan: PlanItem[] | null } | null
  isEnabled: boolean
  /** The user's home folder, for showing paths as ~/… */
  home: string
  /** False once the user hid the collision banner for good (setting pixelOffice.showCollisionRadar). */
  showCollisions: boolean
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; id: string | null }
  | { type: 'send'; id: string; text: string }
  | { type: 'jump'; id: string }
  | { type: 'openTranscript'; id: string }
  | { type: 'retitle'; id: string }
  | { type: 'openPanel'; id: string | null }
  | { type: 'standup'; room: string | null }
  | { type: 'newAgent'; room: string | null }
  | { type: 'enable' }
  | { type: 'hideCollisions' }

const ID = /^[A-Za-z0-9._-]{1,100}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
/** A room is an absolute path; it is only ever compared and used as a cwd, never joined into a path we write. */
const isRoom = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !v.includes('\0')

export function parseFromWebview(m: unknown): FromWebview | null {
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  switch (r.type) {
    case 'ready':
    case 'enable':
    case 'hideCollisions':
      return { type: r.type }
    case 'select':
    case 'openPanel':
      return r.id === null || isId(r.id) ? { type: r.type, id: r.id as string | null } : null
    case 'jump':
    case 'openTranscript':
    case 'retitle':
      return isId(r.id) ? { type: r.type, id: r.id } : null
    case 'standup':
    case 'newAgent':
      return r.room === null || r.room === undefined || isRoom(r.room) ? { type: r.type, room: (r.room as string | undefined) ?? null } : null
    case 'send':
      return isId(r.id) && typeof r.text === 'string' && r.text.trim() && r.text.length <= 4000 ? { type: 'send', id: r.id, text: r.text } : null
  }
  return null
}
