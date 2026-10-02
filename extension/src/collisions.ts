// Collision radar: two live agents that edited the same file.
import type { Seat } from '../../pixel-office/hooks/core/roster'

export type Collision = { file: string; ids: string[]; names: string[] }

export function collisions(seats: Seat[]): Collision[] {
  const byFile = new Map<string, Seat[]>()
  for (const s of seats) {
    if (s.isAway || s.state === 'leaving') continue
    for (const f of new Set(s.files)) byFile.set(f, [...(byFile.get(f) ?? []), s])
  }
  return [...byFile.entries()]
    .filter(([, who]) => who.length > 1)
    .map(([file, who]) => ({ file, ids: who.map(s => s.id), names: who.map(s => s.name) }))
    .sort((a, b) => a.file.localeCompare(b.file))
}
