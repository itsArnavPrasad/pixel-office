// Messages between the webview and the extension. Webview input is untrusted: validate before acting.
import type { Seat } from '../../pixel-office/hooks/core/roster'
import type { Standup } from '../../pixel-office/types'
import type { Collision } from './collisions'
import type { Line } from './transcript'

export type Insight = { changes?: string; tokens?: string; lines?: Line[]; where?: string }

export type ViewState = {
  type: 'view'
  now: number
  seats: Seat[]
  queue: string[]
  standup: Standup | null
  collisions: Collision[]
  insights: Record<string, Insight>
  selected: string | null
  isEnabled: boolean
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; id: string | null }
  | { type: 'send'; id: string; text: string }
  | { type: 'jump'; id: string }
  | { type: 'standup' }
  | { type: 'enable' }

const ID = /^[A-Za-z0-9._-]{1,100}$/

export function parseFromWebview(m: unknown): FromWebview | null {
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  switch (r.type) {
    case 'ready':
    case 'standup':
    case 'enable':
      return { type: r.type }
    case 'select':
      return r.id === null || (typeof r.id === 'string' && ID.test(r.id)) ? { type: 'select', id: r.id as string | null } : null
    case 'jump':
      return typeof r.id === 'string' && ID.test(r.id) ? { type: 'jump', id: r.id } : null
    case 'send':
      return typeof r.id === 'string' && ID.test(r.id) && typeof r.text === 'string' && r.text.trim() && r.text.length <= 4000
        ? { type: 'send', id: r.id, text: r.text }
        : null
  }
  return null
}
