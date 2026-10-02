// Messages between sessions: one file per message, ids sort by time.
import type { InboxMessage } from '../../types'

export const MAX_TEXT = 4000

export function messageId(now: number, rand: number): string {
  const r = Math.floor(rand * 36 ** 6).toString(36).padStart(6, '0')
  return `${String(now).padStart(13, '0')}-${r}`
}

export function makeMessage(from: string, fromName: string, text: string, now: number, rand: number): InboxMessage | null {
  const body = text.trim()
  if (!body || body.length > MAX_TEXT) return null
  return { v: 1, id: messageId(now, rand), from, fromName, text: body, sentAt: now }
}

const ID = /^\d{13}-[0-9a-z]{6}$/

export function parseMessage(text: string): InboxMessage | null {
  try {
    const m: unknown = JSON.parse(text)
    if (!m || typeof m !== 'object') return null
    const r = m as Record<string, unknown>
    const ok =
      r.v === 1 && typeof r.id === 'string' && ID.test(r.id) && typeof r.from === 'string' &&
      typeof r.fromName === 'string' && r.fromName.length <= 100 && typeof r.text === 'string' &&
      r.text.trim().length > 0 && r.text.length <= MAX_TEXT && typeof r.sentAt === 'number'
    return ok ? (r as InboxMessage) : null
  } catch {
    return null
  }
}

/**
 * Message files not yet delivered, oldest first. Delivery deletes the file, and the ids
 * delivered so far are remembered too, so a file whose delete failed is never delivered twice
 * and a message that arrives out of order is never skipped.
 */
export function pendingFiles(names: string[], delivered: readonly string[]): string[] {
  const done = new Set(delivered)
  return [...new Set(names)].filter(n => n.endsWith('.json') && ID.test(n.slice(0, -5)) && !done.has(n.slice(0, -5))).sort()
}

export const DELIVERED_KEEP = 200

/** The prompt a delivered message becomes in the receiving session. */
export function asPrompt(m: InboxMessage): string {
  // always labelled: anything that can write the shared folder can drop a message, so the
  // receiving session should know where the words came from
  return m.from === 'you'
    ? `[Sent to you through Pixel Office]\n\n${m.text}`
    : `[Message from the Claude session "${m.fromName}" via Pixel Office]\n\n${m.text}`
}
