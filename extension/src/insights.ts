// Per-agent extras the editor can afford: git changes, transcript lines, tokens.
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { Seat } from '../../pixel-office/hooks/core/roster'
import { changesIn, describeChanges } from './git'
import type { Insight } from './protocol'
import { consume, emptyTranscript, formatTokens, totalTokens, type TranscriptState } from './transcript'

const CHUNK = 4 << 20
const projects = join(homedir(), '.claude', 'projects')

type Tail = { path: string | null; state: TranscriptState; decoder: StringDecoder }

export class Insights {
  private tails = new Map<string, Tail>()

  /** Recomputes the extras for every seat; slow parts are cached or incremental. */
  async refresh(seats: Seat[], showTokens: boolean): Promise<Record<string, Insight>> {
    const out: Record<string, Insight> = {}
    for (const s of seats) {
      const tail = await this.tail(s.id)
      const changes = s.cwd ? await changesIn(s.cwd) : null
      out[s.id] = {
        changes: changes ? describeChanges(changes) : undefined,
        tokens: showTokens && tail.path ? formatTokens(totalTokens(tail.state.tokens)) : undefined,
        lines: tail.state.lines,
        where: s.cwd ? basename(s.cwd) : undefined,
      }
    }
    for (const id of this.tails.keys()) if (!seats.some(s => s.id === id)) this.tails.delete(id)
    return out
  }

  private async tail(id: string): Promise<Tail> {
    let t = this.tails.get(id)
    if (!t) this.tails.set(id, (t = { path: await findTranscript(id), state: emptyTranscript(), decoder: new StringDecoder('utf8') }))
    if (!t.path) {
      t.path = await findTranscript(id) // it appears after the session's first turn
      if (!t.path) return t
    }
    const size = await stat(t.path).then(s => s.size, () => -1)
    if (size < 0) return t
    if (size < t.state.offset) (t.state = emptyTranscript()), (t.decoder = new StringDecoder('utf8')) // rewritten: start over
    if (size === t.state.offset) return t
    const fh = await open(t.path, 'r')
    try {
      while (t.state.offset < size) {
        const len = Math.min(CHUNK, size - t.state.offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, t.state.offset)
        if (!bytesRead) break
        // the decoder holds a character split across two reads until its second half arrives
        t.state = consume(t.state, t.decoder.write(buf.subarray(0, bytesRead)), bytesRead)
      }
    } finally {
      await fh.close()
    }
    return t
  }
}

/** ~/.claude/projects/<any project>/<session id>.jsonl */
async function findTranscript(id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) return null
  for (const dir of await readdir(projects).catch(() => [])) {
    const p = join(projects, dir, `${id}.jsonl`)
    if (await stat(p).then(() => true, () => false)) return p
  }
  return null
}
