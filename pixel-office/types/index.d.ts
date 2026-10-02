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
  /** The raw detail behind the bubble (the exact command, the file path), for hover and the console. */
  detail: string
  isBusy: boolean
  /** When this session arrived; stable, unlike `since`. */
  joinedAt: number
  since: number
  heartbeat: number
  turns: number
  tools: number
  interns: number
  lastLine: string
  /** The Claude process id, so an editor can find the terminal it runs in (0 = unknown). */
  pid: number
  /** The last absolute paths this session edited, newest first. */
  files: string[]
  /** Which office room: the repository root (worktrees share their main tree's), else the cwd. */
  room: string
  /** The room's display name: the repository's name, else the folder's. */
  roomName: string
  /** What it is working on, from its latest prompt that names the work: the desk title unless `title` is set. */
  task: string
  /** A desk title you set by hand ('' = none, so `task` shows). */
  title: string
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
export type AlertMemory = Record<string, { since: number; isReminded: boolean; seenAt?: number }>

/** ~/.claude/pixel-office/standup/<id>.json */
export type StandupRequest = { v: 1; id: string; by: string; requestedAt: number; room?: string }

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

/** ~/.claude/pixel-office/spawn/<id>.json: an editor asked for a new agent in a room. */
export type SpawnTicket = { v: 1; id: string; room: string; name: string; task: string; character: string; createdAt: number }

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
