// Several editor windows can each run the extension; one of them (the UI leader) notifies.
export type Peer = { v: 1; id: string; startedAt: number; heartbeat: number; isFocused?: boolean; isNotifying?: boolean }

export const PEER_FRESH_MS = 10_000

export function parsePeer(text: string): Peer | null {
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    return p && p.v === 1 && typeof p.id === 'string' && /^[a-z0-9-]{1,64}$/.test(p.id) &&
      typeof p.startedAt === 'number' && typeof p.heartbeat === 'number'
      ? (p as Peer)
      : null
  } catch {
    return null
  }
}

/** The earliest-started window whose heartbeat is fresh; ties by id. */
export function uiLeader(peers: Peer[], now: number): string | null {
  const live = peers.filter(p => now - p.heartbeat < PEER_FRESH_MS)
  live.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  return live[0]?.id ?? null
}
