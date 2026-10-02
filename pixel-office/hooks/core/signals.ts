// What a tool call looks like in the office: an activity and a bubble.
import type { AgentState } from '../../types'
import { basename, bubble } from './text'

export type Activity = { state: AgentState; bubble: string }

type Input = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function activityFor(tool: string, input: Input = {}): Activity {
  const file = basename(str(input.file_path) || str(input.notebook_path) || str(input.path))
  switch (tool) {
    case 'Bash':
      return { state: 'typing', bubble: bubble(`$ ${str(input.command)}`) }
    case 'Read':
      return { state: 'reading', bubble: bubble(file || 'reading') }
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { state: 'reading', bubble: bubble(`🔍 ${str(input.pattern) || file}`) }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { state: 'writing', bubble: bubble(`✎ ${file}`) }
    case 'TodoWrite':
      return { state: 'writing', bubble: 'updating my todo list' }
    case 'WebSearch':
      return { state: 'browsing', bubble: bubble(`🌐 ${str(input.query)}`) }
    case 'WebFetch':
      return { state: 'browsing', bubble: bubble(`🌐 ${hostOf(str(input.url))}`) }
    case 'Agent':
    case 'Task':
      return { state: 'delegating', bubble: bubble(`→ intern: ${str(input.description) || 'helping'}`) }
    case 'AskUserQuestion':
      return { state: 'needs-you', bubble: bubble(firstQuestion(input) || 'I have a question') }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return { state: 'working', bubble: bubble(`${mcp[1]}: ${mcp[2]}`) }
  return { state: 'working', bubble: bubble(tool) }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function firstQuestion(input: Input): string {
  const qs = input.questions
  if (Array.isArray(qs) && qs[0] && typeof qs[0] === 'object') return str((qs[0] as Input).question)
  return ''
}
