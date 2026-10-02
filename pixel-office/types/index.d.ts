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
  /** When this session arrived; stable, unlike `since`. */
  joinedAt: number
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

/** Waiting episodes already announced, by seat id (episode = the seat's `since`). */
export type AlertMemory = Record<string, { since: number; isReminded: boolean }>

/** ~/.claude/pixel-office/standup/<id>.json */
export type StandupRequest = { v: 1; id: string; by: string; requestedAt: number }

/** ~/.claude/pixel-office/standup/<request id>/<session id>.json */
export type StandupAnswer = {
  v: 1
  id: string
  name: string
  character: string
  done: string
  next: string
  blocked: string
  at: number
}

export type Standup = { request: StandupRequest; answers: StandupAnswer[] }

declare module 'claude-code' {
  interface PluginState {
    'pixel-office': {
      me: AgentRecord | null
      roster: AgentRecord[]
      selected: string | null
      logs: Record<string, LogLine[]>
      alerted: AlertMemory
      standup: Standup | null
    }
  }
}
