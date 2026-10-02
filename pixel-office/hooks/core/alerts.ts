// Who is waiting on you, who rings the bell, and when.
import type { AlertMemory } from '../../types'
import type { Seat } from './roster'

export const REMIND_MS = 3 * 60 * 1000

/** Seats blocked on you, longest wait first. */
export function waitingQueue(seats: Seat[]): Seat[] {
  return seats.filter(s => s.state === 'needs-you' && !s.isAway).sort((a, b) => a.since - b.since || a.id.localeCompare(b.id))
}

/**
 * The one session that plays the chime and posts the OS notification, so N
 * open sessions ring once: the earliest arrival that is not away.
 */
export function alertLeader(seats: Seat[]): string | null {
  const here = seats.filter(s => !s.isAway).sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
  return here[0]?.id ?? null
}

export type AlertsDue = { fresh: Seat[]; remind: Seat[]; memory: AlertMemory }

/**
 * Compares the queue with what was already announced. A waiting episode is
 * keyed by the seat's `since`: a new episode fires once, gets one reminder
 * after REMIND_MS, and is forgotten once the seat stops waiting.
 */
export function alertsDue(queue: Seat[], memory: AlertMemory, now: number): AlertsDue {
  const fresh: Seat[] = []
  const remind: Seat[] = []
  const next: AlertMemory = {}
  for (const s of queue) {
    const seen = memory[s.id]
    if (!seen || seen.since !== s.since) {
      fresh.push(s)
      next[s.id] = { since: s.since, isReminded: false }
    } else if (!seen.isReminded && now - s.since >= REMIND_MS) {
      remind.push(s)
      next[s.id] = { since: s.since, isReminded: true }
    } else next[s.id] = seen
  }
  return { fresh, remind, memory: next }
}

export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** A macOS notification; the words are argv items, never script source. */
export function notifyArgv(title: string, body: string): string[] {
  return [
    'osascript',
    '-e', 'on run argv',
    '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
    '-e', 'end run',
    '--', body, title,
  ]
}
