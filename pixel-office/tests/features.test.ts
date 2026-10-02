import { describe, expect, test } from 'claude-code/testing'

import type { StandupAnswer } from '../types'
import { newAgent } from '../hooks/core/agent'
import { REMIND_MS, alertLeader, alertsDue, formatWait, notifyArgv, waitingQueue } from '../hooks/core/alerts'
import { messageId } from '../hooks/core/inbox'
import { TICKET_MS, groupRooms, parseTicket, remoteName, roomOf, ticketsFor, uniqueName } from '../hooks/core/rooms'
import type { Seat } from '../hooks/core/roster'
import {
  TURN_MS, digest, headline, latestRequest, makeRequest, parseAnswer, parseReport, parseRequest, presenter,
} from '../hooks/core/standup'

const T = 1_759_400_000_000
const seat = (id: string, over: Partial<Seat> = {}): Seat => ({ ...newAgent(id, T), isAway: false, isMe: false, ...over })
const answer = (id: string, over: Partial<StandupAnswer> = {}): StandupAnswer => ({
  v: 1, id, name: id, character: 'dev-1', done: 'shipped it', next: 'tests', blocked: '', at: T, ...over,
})

describe('attention queue', () => {
  test('waitingQueue: only needs-you, not away, longest wait first', () => {
    const q = waitingQueue([
      seat('late', { state: 'needs-you', since: T + 50 }),
      seat('busy', { state: 'typing' }),
      seat('early', { state: 'needs-you', since: T + 10 }),
      seat('ghost', { state: 'needs-you', since: T, isAway: true }),
    ])
    expect(q.map(s => s.id)).toEqual(['early', 'late'])
  })

  test('alertLeader: earliest arrival that is here; ties by id; none when empty', () => {
    expect(alertLeader([seat('b', { joinedAt: T + 5 }), seat('a', { joinedAt: T + 9, since: T }), seat('z', { joinedAt: T, isAway: true })])).toBe('b')
    expect(alertLeader([seat('b', { joinedAt: T }), seat('a', { joinedAt: T })])).toBe('a')
    expect(alertLeader([])).toBe(null)
  })

  test('alertsDue: fires once, reminds once after 3 min, forgets when cleared', () => {
    const w = seat('w', { state: 'needs-you', since: T })
    let r = alertsDue([w], {}, T + 1000)
    expect([r.fresh.map(s => s.id), r.remind.length]).toEqual([['w'], 0])
    r = alertsDue([w], r.memory, T + 2000)
    expect([r.fresh.length, r.remind.length]).toEqual([0, 0])
    r = alertsDue([w], r.memory, T + REMIND_MS)
    expect(r.remind.map(s => s.id)).toEqual(['w'])
    r = alertsDue([w], r.memory, T + REMIND_MS * 5)
    expect([r.fresh.length, r.remind.length]).toEqual([0, 0])
    r = alertsDue([], r.memory, T + REMIND_MS * 6)
    expect(r.memory).toEqual({})
    r = alertsDue([{ ...w, since: T + REMIND_MS * 7 }], r.memory, T + REMIND_MS * 7)
    expect(r.fresh.map(s => s.id)).toEqual(['w'])
  })

  test('alertsDue: a new waiting episode (new since) fires again', () => {
    const first = alertsDue([seat('w', { state: 'needs-you', since: T })], {}, T)
    const again = alertsDue([seat('w', { state: 'needs-you', since: T + 5000 })], first.memory, T + 5000)
    expect(again.fresh.length).toBe(1)
  })

  test('formatWait', () => {
    expect([0, 45_000, 60_000, 125_000, 3_600_000, 5_400_000, -5].map(formatWait)).toEqual(['0s', '45s', '1m', '2m', '1h', '1h 30m', '0s'])
  })

  test('notifyArgv keeps the words out of the script', () => {
    const argv = notifyArgv('web" & do shell script "rm', 'body"; quit')
    const script = argv.filter((_, i) => argv[i - 1] === '-e').join('\n')
    expect(script).not.toContain('rm')
    expect(script).not.toContain('quit')
    expect(argv.slice(-2)).toEqual(['body"; quit', 'web" & do shell script "rm'])
  })
})

describe('standup', () => {
  test('parseReport: clean three lines', () => {
    expect(parseReport('Done: fixed login\nNext: add tests\nBlocked: nothing')).toEqual({ done: 'fixed login', next: 'add tests', blocked: '' })
  })
  test('parseReport: bullets, bold, casing, blockers synonym', () => {
    expect(parseReport('- **Done:** wired the API\n* NEXT - deploy\n1. Blockers: need the DB password')).toEqual({
      done: 'wired the API', next: 'deploy', blocked: 'need the DB password',
    })
  })
  test('parseReport: partial and free text', () => {
    expect(parseReport('Next: refactor')).toEqual({ done: '', next: 'refactor', blocked: '' })
    expect(parseReport('I mostly read code today.')).toEqual({ done: 'I mostly read code today.', next: '', blocked: '' })
    expect(parseReport('')).toEqual({ done: '', next: '', blocked: '' })
    expect([...parseReport(`Done: ${'x'.repeat(300)}`).done].length).toBe(100)
  })
  test('request and answer validation', () => {
    const id = messageId(T, 0.3)
    const req = makeRequest(id, 'first', T)
    expect(parseRequest(JSON.stringify(req))).toEqual(req)
    expect(parseRequest(JSON.stringify({ ...req, id: '../x' }))).toBe(null)
    expect(parseRequest('nope')).toBe(null)
    expect(parseAnswer(JSON.stringify(answer('a')))).toEqual(answer('a'))
    expect(parseAnswer(JSON.stringify({ ...answer('a'), done: 5 }))).toBe(null)
    expect(parseAnswer(JSON.stringify({ ...answer('a'), id: '' }))).toBe(null)
  })
  test('latestRequest: newest inside the window, ignores junk', () => {
    const a = messageId(T, 0.1)
    const b = messageId(T + 1000, 0.1)
    expect(latestRequest([`${a}.json`, `${b}.json`, 'x.json', b], T + 2000, 60_000)).toBe(b)
    expect(latestRequest([`${a}.json`], T + 120_000, 60_000)).toBe(null)
    expect(latestRequest([], T, 60_000)).toBe(null)
  })
  test('presenter: takes turns in answer order and wraps', () => {
    const list = [answer('b', { at: T + 2 }), answer('a', { at: T + 1 })]
    expect(presenter(list, T, T)).toBe('a')
    expect(presenter(list, T, T + TURN_MS)).toBe('b')
    expect(presenter(list, T, T + TURN_MS * 2)).toBe('a')
    expect(presenter([], T, T)).toBe(null)
  })
  test('headline: blocked wins, then done, then next', () => {
    expect(headline(answer('a', { blocked: 'need keys' }))).toBe('Blocked: need keys')
    expect(headline(answer('a'))).toBe('Done: shipped it')
    expect(headline(answer('a', { done: '' }))).toBe('Next: tests')
    expect(headline(answer('a', { done: '', next: '' }))).toBe('Nothing to report.')
  })
})

describe('rooms', () => {
  test('remoteName reads every common remote shape', () => {
    expect(remoteName('git@github.com:acme/web-app.git')).toBe('web-app')
    expect(remoteName('https://github.com/acme/api')).toBe('api')
    expect(remoteName('https://gitlab.com/g/sub/svc.git/')).toBe('svc')
    expect(remoteName('ssh://git@host:22/team/x.git')).toBe('x')
    expect(remoteName(null)).toBe('')
  })
  test('roomOf: repo root and remote name, else the folder', () => {
    expect(roomOf('/r/web/src', { root: '/r/web', remote: 'git@h:a/web-app.git' })).toEqual({ room: '/r/web', roomName: 'web-app' })
    expect(roomOf('/r/wt-feature', { root: '/r/web', remote: null })).toEqual({ room: '/r/web', roomName: 'web' })
    expect(roomOf('/tmp/scratch', null)).toEqual({ room: '/tmp/scratch', roomName: 'scratch' })
  })
  test('groupRooms: one room per repo, rooms with waiting agents first', () => {
    const rooms = groupRooms([
      seat('a', { room: '/r/zeta', roomName: 'zeta' }),
      seat('b', { room: '/r/alpha', roomName: 'alpha' }),
      seat('c', { room: '/r/zeta', roomName: 'zeta', state: 'needs-you' }),
      seat('d', { room: '', cwd: '/r/old', roomName: '' }),
    ])
    expect(rooms.map(r => [r.name, r.seats.map(s => s.id), r.waiting])).toEqual([
      ['zeta', ['a', 'c'], 1], ['alpha', ['b'], 0], ['old', ['d'], 0],
    ])
  })
  test('uniqueName never repeats a name in a room, ignoring case', () => {
    expect(uniqueName('api', [])).toBe('api')
    expect(uniqueName('api', ['API'])).toBe('api 2')
    expect(uniqueName('api', ['api', 'api 2'])).toBe('api 3')
  })
  test('tickets: validated, only this room, only fresh, oldest first', () => {
    const t = (id: string, room: string, createdAt: number) => ({ v: 1 as const, id, room, name: 'bot', task: 'do it', character: 'dev-2', createdAt })
    const a = t(messageId(T, 0.1), '/r/web', T)
    expect(parseTicket(JSON.stringify(a))).toEqual(a)
    expect(parseTicket(JSON.stringify({ ...a, room: 'relative' }))).toBe(null)
    expect(parseTicket(JSON.stringify({ ...a, name: 'x'.repeat(41) }))).toBe(null)
    expect(parseTicket('{')).toBe(null)
    const b = t(messageId(T + 5, 0.1), '/r/web', T + 5)
    const other = t(messageId(T, 0.2), '/r/api', T)
    const old = t(messageId(T - TICKET_MS, 0.3), '/r/web', T - TICKET_MS)
    expect(ticketsFor([b, other, old, a], '/r/web', T + 10).map(x => x.id)).toEqual([a.id, b.id])
  })
})

describe('standup digest', () => {
  test('newest messages that fit, with tool names', () => {
    const msgs = [
      { role: 'user', text: 'fix login', toolUses: [] },
      { role: 'assistant', text: 'Done, tests pass.', toolUses: [{ tool: 'Bash' }, { tool: 'Bash' }, { tool: 'Edit' }] },
    ]
    expect(digest(msgs)).toBe('user: fix login\nassistant: Done, tests pass. [tools: Bash, Edit]')
    expect(digest(msgs, 50)).toBe('assistant: Done, tests pass. [tools: Bash, Edit]')
    expect(digest([])).toBe('')
  })
})
