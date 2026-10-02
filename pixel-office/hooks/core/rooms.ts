// Rooms: every session in one repository (worktrees included) shares an office room.
import type { SpawnTicket } from '../../types'
import type { Seat } from './roster'
import { basename } from './text'

/** The repository name in a remote URL: git@host:acme/web-app.git → web-app. */
export function remoteName(remote: string | null | undefined): string {
  if (!remote) return ''
  const last = remote.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1) ?? ''
  return last.replace(/\.git$/, '')
}

/** A session's room: its repository root (a worktree's main tree), else its folder. */
export function roomOf(cwd: string, repo: { root: string; remote: string | null } | null): { room: string; roomName: string } {
  const room = repo?.root || cwd
  return { room, roomName: remoteName(repo?.remote) || basename(room) || 'office' }
}

export type Room = { id: string; name: string; seats: Seat[]; waiting: number }

/** Seats grouped by room, rooms ordered by who needs you, then by name. */
export function groupRooms(seats: Seat[]): Room[] {
  const byRoom = new Map<string, Room>()
  for (const s of seats) {
    const id = s.room || s.cwd || 'office'
    let r = byRoom.get(id)
    if (!r) byRoom.set(id, (r = { id, name: s.roomName || basename(id) || 'office', seats: [], waiting: 0 }))
    r.seats.push(s)
    if (s.state === 'needs-you' && !s.isAway) r.waiting++
  }
  return [...byRoom.values()].sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** `base`, or `base 2`, `base 3`… so two sessions in one room never share a name. */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map(n => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}

// ── spawn tickets ─────────────────────────────────────────────────
export const TICKET_MS = 3 * 60 * 1000
const TICKET_ID = /^\d{13}-[0-9a-z]{6}$/

export function parseTicket(text: string): SpawnTicket | null {
  try {
    const t = JSON.parse(text) as Record<string, unknown>
    const ok =
      t && t.v === 1 && typeof t.id === 'string' && TICKET_ID.test(t.id) && typeof t.room === 'string' && t.room.startsWith('/') &&
      typeof t.name === 'string' && t.name.length <= 40 && typeof t.task === 'string' && t.task.length <= 4000 &&
      typeof t.character === 'string' && t.character.length <= 20 && typeof t.createdAt === 'number'
    return ok ? (t as SpawnTicket) : null
  } catch {
    return null
  }
}

/** Fresh tickets for this room, oldest first: the order a new session tries to claim them in. */
export function ticketsFor(tickets: SpawnTicket[], room: string, now: number): SpawnTicket[] {
  return tickets.filter(t => t.room === room && now - t.createdAt >= 0 && now - t.createdAt < TICKET_MS).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
