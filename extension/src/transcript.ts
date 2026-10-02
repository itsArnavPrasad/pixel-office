// Reading a session's transcript (~/.claude/projects/<project>/<session>.jsonl) as it grows:
// the recent conversation for the dialogue box, and the tokens it used.
// The format is Claude Code's own and not a public contract, so every line is read defensively.
import { clean, truncate } from '../../pixel-office/hooks/core/text'

export type Line = { who: 'you' | 'agent' | 'tool'; text: string }
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type TranscriptState = { offset: number; partial: string; lines: Line[]; tokens: Tokens; seen: string[] }

const KEEP_LINES = 12
const KEEP_SEEN = 400

export const emptyTranscript = (): TranscriptState => ({
  offset: 0, partial: '', lines: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, seen: [],
})

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Folds a chunk of appended file text into the state; `bytes` is the chunk's length on disk. */
export function consume(state: TranscriptState, chunk: string, bytes: number): TranscriptState {
  const text = state.partial + chunk
  const cut = text.lastIndexOf('\n')
  const complete = cut < 0 ? '' : text.slice(0, cut)
  const next: TranscriptState = {
    offset: state.offset + bytes,
    partial: cut < 0 ? text : text.slice(cut + 1),
    lines: [...state.lines],
    tokens: { ...state.tokens },
    seen: [...state.seen],
  }
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue
    let row: Obj | null
    try {
      row = obj(JSON.parse(raw))
    } catch {
      continue
    }
    if (!row || row.isMeta === true || row.isSidechain === true) continue
    const message = obj(row.message)
    if (!message) continue

    if (row.type === 'assistant') {
      // one API message is written as several rows (one per block) sharing its id and usage
      const id = typeof message.id === 'string' ? message.id : ''
      const usage = obj(message.usage)
      if (usage && id && !next.seen.includes(id)) {
        next.seen.push(id)
        next.tokens.input += num(usage.input_tokens)
        next.tokens.output += num(usage.output_tokens)
        next.tokens.cacheRead += num(usage.cache_read_input_tokens)
        next.tokens.cacheWrite += num(usage.cache_creation_input_tokens)
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const b = obj(block)
        if (b?.type === 'text' && typeof b.text === 'string') push(next, 'agent', b.text)
        else if (b?.type === 'tool_use' && typeof b.name === 'string') push(next, 'tool', toolLine(b))
      }
    } else if (row.type === 'user') {
      const c = message.content
      if (typeof c === 'string') push(next, 'you', c)
      else if (Array.isArray(c))
        for (const block of c) {
          const b = obj(block)
          if (b?.type === 'text' && typeof b.text === 'string') push(next, 'you', b.text)
        }
    }
  }
  next.seen = next.seen.slice(-KEEP_SEEN)
  return next
}

function toolLine(b: Obj): string {
  const input = obj(b.input) ?? {}
  const arg = [input.command, input.file_path, input.pattern, input.url, input.query, input.description].find(
    v => typeof v === 'string',
  ) as string | undefined
  return `${String(b.name)}${arg ? `(${arg})` : ''}`
}

function push(s: TranscriptState, who: Line['who'], text: string) {
  // the engine's own wrappers (command echoes, reminders) are not conversation
  if (who === 'you' && /^\s*<[a-z-]+>/.test(text)) return
  const t = truncate(clean(text), 400)
  if (!t) return
  s.lines.push({ who, text: t })
  if (s.lines.length > KEEP_LINES) s.lines.splice(0, s.lines.length - KEEP_LINES)
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
