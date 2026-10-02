export type AgentState =
  | 'arriving'
  | 'idle'
  | 'thinking'
  | 'typing'
  | 'reading'
  | 'writing'
  | 'browsing'
  | 'delegating'
  | 'working'
  | 'needs-you'
  | 'stressed'
  | 'done'
  | 'leaving'

/** One session's presence file, ~/.claude/pixel-office/agents/<id>.json. */
export type AgentRecord = {
  v: 1
  id: string
  name: string
  cwd: string
  character: string
  state: AgentState
  bubble: string
  isBusy: boolean
  since: number
  heartbeat: number
  turns: number
  tools: number
  interns: number
  lastLine: string
}

/** One message, ~/.claude/pixel-office/inbox/<to>/<id>.json. */
export type InboxMessage = {
  v: 1
  id: string
  from: string
  fromName: string
  text: string
  sentAt: number
}

export type LogLine = { at: number; who: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'pixel-office': {
      me: AgentRecord | null
      roster: AgentRecord[]
      selected: string | null
      logs: Record<string, LogLine[]>
    }
  }
}
