// Reading a session's transcript (~/.claude/projects/<project>/<session>.jsonl) as it grows:
// the live conversation for the agent console, and the tokens it used.
// The format is Claude Code's own and not a public contract, so every line is read defensively.
import { clean, truncate } from '../../pixel-office/hooks/core/text'

/** One thing in the conversation: a prompt, a reply, or a tool call with its result attached. */
export type Entry = {
  kind: 'you' | 'agent' | 'tool'
  text: string
  at: number
  tool?: string
  /** The tool call's arguments, pretty JSON, capped. */
  input?: string
  /** The tool's result, capped; absent while it runs. */
  output?: string
  isError?: boolean
  /** The tool_use id, so a later result finds its call. */
  callId?: string
}
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
/** One item of the agent's own plan, from its latest todo list. */
export type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'completed' }
export type TranscriptState = {
  offset: number; partial: string; entries: Entry[]; tokens: Tokens; seen: string[]
  /** Your latest prompt: what the agent is working on. */
  task: string
  plan: PlanItem[] | null
}

export const KEEP_ENTRIES = 200
const KEEP_SEEN = 400
const TEXT_MAX = 6000
const IO_MAX = 4000

export const emptyTranscript = (): TranscriptState => ({
  offset: 0, partial: '', entries: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, seen: [], task: '', plan: null,
})

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

/** Folds a chunk of appended file text into the state; `bytes` is the chunk's length on disk. */
export function consume(state: TranscriptState, chunk: string, bytes: number): TranscriptState {
  const text = state.partial + chunk
  const cut = text.lastIndexOf('\n')
  const complete = cut < 0 ? '' : text.slice(0, cut)
  const next: TranscriptState = {
    offset: state.offset + bytes,
    partial: cut < 0 ? text : text.slice(cut + 1),
    entries: [...state.entries],
    tokens: { ...state.tokens },
    seen: [...state.seen],
    task: state.task,
    plan: state.plan,
  }
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue
    let row: Obj | null
    try {
      row = obj(JSON.parse(raw))
    } catch {
      continue
    }
    if (!row || row.isSidechain === true) continue
    const message = obj(row.message)
    if (!message) continue
    const at = Date.parse(typeof row.timestamp === 'string' ? row.timestamp : '') || 0

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
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) push(next, { kind: 'agent', text: cap(b.text.trim(), TEXT_MAX), at })
        else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          if (b.name === 'TodoWrite') next.plan = planOf(b.input) ?? next.plan
          push(next, { kind: 'tool', tool: b.name, text: summary(b), input: inputOf(b.input), at, callId: typeof b.id === 'string' ? b.id : undefined })
        }
      }
    } else if (row.type === 'user' && row.isMeta !== true) {
      const c = message.content
      if (typeof c === 'string') prompt(next, c, at)
      else if (Array.isArray(c))
        for (const block of c) {
          const b = obj(block)
          if (b?.type === 'text' && typeof b.text === 'string') prompt(next, b.text, at)
          else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') attach(next, b)
        }
    }
  }
  next.seen = next.seen.slice(-KEEP_SEEN)
  return next
}

function prompt(s: TranscriptState, text: string, at: number) {
  // the engine's own wrappers (command echoes, reminders, task notifications) are not your words
  if (/^\s*<[a-z-]+>/.test(text)) return
  if (!text.trim()) return
  push(s, { kind: 'you', text: cap(text.trim(), TEXT_MAX), at })
  s.task = truncate(clean(text), 300)
}

function planOf(input: unknown): PlanItem[] | null {
  const todos = obj(input)?.todos
  if (!Array.isArray(todos)) return null
  const items: PlanItem[] = []
  for (const t of todos.slice(0, 40)) {
    const o = obj(t)
    const status = o?.status
    if (typeof o?.content !== 'string' || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) continue
    items.push({ text: truncate(clean(o.content), 160), status })
  }
  return items
}

/** What the console shows: messages as they are, and each run of tool calls folded into one summary. */
export type Block =
  | { kind: 'message'; entry: Entry; index: number }
  | { kind: 'actions'; entries: { entry: Entry; index: number }[]; summary: string; failed: number; running: number; at: number }

const NOUN: Record<string, [string, string]> = {
  Edit: ['edit', 'edits'], MultiEdit: ['edit', 'edits'], Write: ['new file', 'new files'], NotebookEdit: ['edit', 'edits'],
  Bash: ['command', 'commands'], Read: ['read', 'reads'], Grep: ['search', 'searches'], Glob: ['search', 'searches'],
  WebFetch: ['web page', 'web pages'], WebSearch: ['web search', 'web searches'], Agent: ['subagent', 'subagents'], Task: ['subagent', 'subagents'],
  TodoWrite: ['plan update', 'plan updates'],
}

export function blocks(entries: Entry[]): Block[] {
  const out: Block[] = []
  entries.forEach((entry, index) => {
    if (entry.kind !== 'tool') return void out.push({ kind: 'message', entry, index })
    const last = out.at(-1)
    if (last?.kind === 'actions') last.entries.push({ entry, index })
    else out.push({ kind: 'actions', entries: [{ entry, index }], summary: '', failed: 0, running: 0, at: entry.at })
  })
  for (const b of out) {
    if (b.kind !== 'actions') continue
    const counts = new Map<string, number>()
    for (const { entry } of b.entries) {
      const key = entry.tool && NOUN[entry.tool] ? entry.tool.replace(/^(MultiEdit|NotebookEdit)$/, 'Edit').replace(/^Glob$/, 'Grep').replace(/^Task$/, 'Agent') : 'other'
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (entry.isError) b.failed++
      else if (entry.output === undefined) b.running++
    }
    const parts = [...counts].map(([k, n]) => (k === 'other' ? `${n} other` : `${n} ${NOUN[k]![n === 1 ? 0 : 1]}`))
    b.summary = `${b.entries.length} action${b.entries.length === 1 ? '' : 's'} · ${parts.join(', ')}`
  }
  return out
}

function attach(s: TranscriptState, b: Obj) {
  const call = [...s.entries].reverse().find(e => e.callId === b.tool_use_id)
  if (!call) return
  const content = b.content
  const out =
    typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(x => (obj(x)?.type === 'text' ? String(obj(x)!.text ?? '') : obj(x)?.type === 'image' ? '[image]' : '')).join('\n')
    : ''
  const i = s.entries.lastIndexOf(call)
  s.entries[i] = { ...call, output: cap(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), IO_MAX), isError: b.is_error === true }
}

function summary(b: Obj): string {
  const input = obj(b.input) ?? {}
  const arg = [input.command, input.file_path, input.notebook_path, input.pattern, input.url, input.query, input.description, input.prompt].find(
    v => typeof v === 'string',
  ) as string | undefined
  return arg ? truncate(clean(arg), 160) : ''
}

function inputOf(input: unknown): string | undefined {
  if (input === undefined) return undefined
  try {
    return cap(JSON.stringify(input, null, 2), IO_MAX)
  } catch {
    return undefined
  }
}

function push(s: TranscriptState, e: Entry) {
  s.entries.push(e)
  if (s.entries.length > KEEP_ENTRIES) s.entries.splice(0, s.entries.length - KEEP_ENTRIES)
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "12k new · 1.4M cached": cache reads are cheap, so they are shown apart from the rest. */
export function describeTokens(t: Tokens): string {
  const fresh = t.input + t.output + t.cacheWrite
  return t.cacheRead ? `${formatTokens(fresh)} new · ${formatTokens(t.cacheRead)} cached` : `${formatTokens(fresh)} tokens`
}
