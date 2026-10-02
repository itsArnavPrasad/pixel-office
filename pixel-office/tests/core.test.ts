import { describe, expect, test } from 'claude-code/testing'

import type { AgentRecord } from '../types'
import { HOLD_MS, PRUNE_MS, byUrgency, newAgent, presence, reduce } from '../hooks/core/agent'
import { asPrompt, makeMessage, messageId, parseMessage, pendingFiles } from '../hooks/core/inbox'
import { assignDesks, hash, mergeRoster, parseRecord } from '../hooks/core/roster'
import { activityFor } from '../hooks/core/signals'
import { bubble, clean, firstSentence, redact, truncate, wrap } from '../hooks/core/text'

const T = 1_759_400_000_000
const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({ ...newAgent('a1', T), ...over })

describe('text', () => {
  test('clean strips ANSI, control chars and collapses space', () => {
    expect(clean('\x1b[31mred\x1b[0m\n\tline\x07  two')).toBe('red line two')
  })
  test('truncate counts characters, not UTF-16 units', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('🙂🙂🙂', 3)).toBe('🙂🙂🙂')
    expect(truncate('🙂🙂🙂🙂', 3)).toBe('🙂🙂…')
  })
  test('redact hides common secrets', () => {
    expect(redact('API_KEY=abc123 curl')).toBe('API_KEY=*** curl')
    expect(redact('-H "Authorization: Bearer tok.en"')).toBe('-H "Authorization: Bearer ***')
    expect(redact('mysql --password=hunter2')).toBe('mysql --password=***')
    expect(redact('use sk-ant-abcdefghijkl now')).toBe('use *** now')
  })
  test('firstSentence takes the first sentence of the first text line', () => {
    expect(firstSentence('## Done\n\nFixed it. Then more.')).toBe('Done')
    expect(firstSentence('All **42** tests pass! Great.')).toBe('All 42 tests pass!')
    expect(firstSentence('```js\ncode\n```\nShipped v2.0 today')).toBe('Shipped v2.0 today')
    expect(firstSentence('')).toBe('')
  })
  test('bubble is cleaned, redacted and cut to 60', () => {
    expect([...bubble('x'.repeat(100))].length).toBe(60)
    expect(bubble('TOKEN=zzz')).toBe('TOKEN=***')
  })
  test('wrap breaks on words and splits long words', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrap('', 5)).toEqual([])
  })
})

describe('signals', () => {
  test('each tool maps to its activity', () => {
    expect(activityFor('Bash', { command: 'npm test' })).toEqual({ state: 'typing', bubble: '$ npm test' })
    expect(activityFor('Read', { file_path: '/a/b/c.ts' })).toEqual({ state: 'reading', bubble: 'c.ts' })
    expect(activityFor('Grep', { pattern: 'TODO' }).state).toBe('reading')
    expect(activityFor('Edit', { file_path: 'src/x.ts' })).toEqual({ state: 'writing', bubble: '✎ x.ts' })
    expect(activityFor('WebFetch', { url: 'https://example.com/a' }).bubble).toBe('🌐 example.com')
    expect(activityFor('WebFetch', { url: 'not a url' }).bubble).toBe('🌐 not a url')
    expect(activityFor('Agent', { description: 'scan repo' }).state).toBe('delegating')
    expect(activityFor('AskUserQuestion', { questions: [{ question: 'Which DB?' }] })).toEqual({ state: 'needs-you', bubble: 'Which DB?' })
    expect(activityFor('mcp__github__create_issue')).toEqual({ state: 'working', bubble: 'github: create_issue' })
    expect(activityFor('SomethingNew')).toEqual({ state: 'working', bubble: 'SomethingNew' })
  })
  test('bash bubbles redact secrets and ignore non-string input', () => {
    expect(activityFor('Bash', { command: 'GITHUB_TOKEN=abc gh pr list' }).bubble).toBe('$ GITHUB_TOKEN=*** gh pr list')
    expect(activityFor('Bash', { command: 42 }).bubble).toBe('$')
  })
})

describe('agent reducer', () => {
  test('start → arriving, then idle after the hold', () => {
    const a = reduce(agent(), { kind: 'start', name: 'api', cwd: '/x/api', character: 'dev-2' }, T)
    expect(a).toMatchObject({ state: 'arriving', name: 'api', character: 'dev-2' })
    expect(reduce(a, { kind: 'tick' }, T + HOLD_MS - 1).state).toBe('arriving')
    expect(reduce(a, { kind: 'tick' }, T + HOLD_MS).state).toBe('idle')
  })
  test('prompt → thinking, busy, counts turns', () => {
    const a = reduce(agent(), { kind: 'prompt', text: 'fix the bug please' }, T)
    expect(a).toMatchObject({ state: 'thinking', isBusy: true, turns: 1, bubble: 'fix the bug please' })
  })
  test('tool → activity; done → thinking; error → stressed → thinking', () => {
    let a = reduce(agent({ isBusy: true }), { kind: 'tool', tool: 'Bash', input: { command: 'ls' } }, T)
    expect(a).toMatchObject({ state: 'typing', tools: 1 })
    expect(reduce(a, { kind: 'tool-done', isError: false }, T + 1).state).toBe('thinking')
    a = reduce(a, { kind: 'tool-done', isError: true }, T + 1)
    expect(a.state).toBe('stressed')
    expect(reduce(a, { kind: 'tick' }, T + 1 + HOLD_MS).state).toBe('thinking')
  })
  test('needs-you is sticky until something answers it', () => {
    const a = reduce(agent({ isBusy: true }), { kind: 'needs-you', text: 'Allow rm -rf build?' }, T)
    expect(a).toMatchObject({ state: 'needs-you', bubble: 'Allow rm -rf build?' })
    expect(reduce(a, { kind: 'tick' }, T + 60_000).state).toBe('needs-you')
    expect(reduce(a, { kind: 'tool-done', isError: false }, T + 5).state).toBe('thinking')
    expect(reduce(a, { kind: 'turn-done', text: 'ok' }, T + 5).state).toBe('done')
    expect(reduce(a, { kind: 'prompt', text: 'yes' }, T + 5).state).toBe('thinking')
  })
  test('tool-done while idle changes nothing', () => {
    const a = agent({ state: 'idle' })
    expect(reduce(a, { kind: 'tool-done', isError: false }, T)).toBe(a)
  })
  test('turn-done → done with the first sentence, then idle', () => {
    const a = reduce(agent({ isBusy: true }), { kind: 'turn-done', text: 'Fixed the auth bug. Details…' }, T)
    expect(a).toMatchObject({ state: 'done', bubble: 'Fixed the auth bug.', lastLine: 'Fixed the auth bug.', isBusy: false })
    expect(reduce(a, { kind: 'tick' }, T + HOLD_MS)).toMatchObject({ state: 'idle', bubble: '' })
  })
  test('interns never go negative; end → leaving', () => {
    const a = reduce(agent(), { kind: 'interns', delta: -1 }, T)
    expect(a.interns).toBe(0)
    expect(reduce(reduce(a, { kind: 'interns', delta: 2 }, T), { kind: 'end' }, T)).toMatchObject({ state: 'leaving', interns: 0 })
  })
  test('since only moves when the state or bubble changes', () => {
    const a = agent({ state: 'typing', bubble: '$ ls', since: T })
    expect(reduce(a, { kind: 'tool', tool: 'Bash', input: { command: 'ls' } }, T + 500).since).toBe(T)
  })
  test('presence: here, away, pruned; leaving is pruned after the hold', () => {
    expect(presence(agent({ heartbeat: T }), T + 1000)).toBe('here')
    expect(presence(agent({ heartbeat: T }), T + 25_000)).toBe('away')
    expect(presence(agent({ heartbeat: T }), T + PRUNE_MS + 1)).toBe(null)
    expect(presence(agent({ heartbeat: T, state: 'leaving' }), T + HOLD_MS + 1)).toBe(null)
  })
  test('byUrgency puts needs-you first, then working, then idle', () => {
    const list = [agent({ id: 'i', state: 'idle' }), agent({ id: 'w', state: 'typing' }), agent({ id: 'n', state: 'needs-you' })]
    expect(list.sort(byUrgency).map(a => a.id)).toEqual(['n', 'w', 'i'])
  })
})

describe('roster', () => {
  test('parseRecord accepts a valid record and rejects junk', () => {
    const good = agent()
    expect(parseRecord(JSON.stringify(good))).toEqual(good)
    expect(parseRecord('{nope')).toBe(null)
    expect(parseRecord('[]')).toBe(null)
    expect(parseRecord('null')).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, v: 2 }))).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, state: 'dancing' }))).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, heartbeat: 'soon' }))).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, id: '' }))).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, name: 'x'.repeat(101) }))).toBe(null)
  })
  test('mergeRoster prunes, marks away, dedupes and prefers me', () => {
    const me = agent({ id: 'me', since: T })
    const seats = mergeRoster([
      agent({ id: 'b', since: T + 2, heartbeat: T }),
      agent({ id: 'b', since: T + 2, heartbeat: T - 5 }),
      agent({ id: 'old', heartbeat: T - PRUNE_MS - 10 }),
      agent({ id: 'me', name: 'stale copy', heartbeat: T - 99 }),
      agent({ id: 'c', since: T + 1, heartbeat: T - 30_000 }),
      null,
    ], me, T)
    expect(seats.map(s => s.id)).toEqual(['me', 'c', 'b'])
    expect(seats[0]).toMatchObject({ isMe: true, name: 'claude', isAway: false })
    expect(seats[1]!.isAway).toBe(true)
  })
  test('assignDesks is stable, collision-free and overflows', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5']
    const a = assignDesks(ids, 8)
    expect(new Set(a.values()).size).toBe(5)
    expect(assignDesks([...ids].reverse(), 8)).toEqual(a)
    const small = assignDesks(ids, 3)
    expect([...small.values()].filter(d => d === -1).length).toBe(2)
    expect([...small.values()].filter(d => d >= 0).sort()).toEqual([0, 1, 2])
  })
  test('hash is a stable 32-bit number', () => {
    expect(hash('abc')).toBe(hash('abc'))
    expect(hash('abc')).not.toBe(hash('abd'))
    expect(hash('') >= 0 && hash('x') <= 0xffffffff).toBe(true)
  })
})

describe('inbox', () => {
  test('messageId sorts by time', () => {
    expect(messageId(T, 0.5) < messageId(T + 1, 0)).toBe(true)
    expect(messageId(T, 0)).toMatch(/^\d{13}-[0-9a-z]{6}$/)
    expect(messageId(T, 0.999999999)).toMatch(/^\d{13}-[0-9a-z]{6}$/)
  })
  test('makeMessage trims and rejects empty or oversize text', () => {
    expect(makeMessage('you', 'you', '  hi  ', T, 0.1)?.text).toBe('hi')
    expect(makeMessage('you', 'you', '   ', T, 0.1)).toBe(null)
    expect(makeMessage('you', 'you', 'x'.repeat(4001), T, 0.1)).toBe(null)
  })
  test('parseMessage round-trips and rejects junk', () => {
    const m = makeMessage('s1', 'web', 'update the README', T, 0.2)!
    expect(parseMessage(JSON.stringify(m))).toEqual(m)
    expect(parseMessage(JSON.stringify({ ...m, id: '../../etc' }))).toBe(null)
    expect(parseMessage(JSON.stringify({ ...m, text: '' }))).toBe(null)
    expect(parseMessage(JSON.stringify({ ...m, text: 5 }))).toBe(null)
    expect(parseMessage('garbage')).toBe(null)
  })
  test('pendingFiles: newer than cursor, sorted, deduped, only message files', () => {
    const a = `${messageId(T, 0.1)}.json`
    const b = `${messageId(T + 5, 0.1)}.json`
    expect(pendingFiles([b, a, a, 'notes.txt', 'x.json'], '')).toEqual([a, b])
    expect(pendingFiles([a, b], a.slice(0, -5))).toEqual([b])
    expect(pendingFiles([a, b], b.slice(0, -5))).toEqual([])
  })
  test('asPrompt: your words pass through, agent messages are labelled', () => {
    expect(asPrompt(makeMessage('you', 'you', 'run tests', T, 0)!)).toBe('run tests')
    expect(asPrompt(makeMessage('s2', 'web', 'hi', T, 0)!)).toContain('"web"')
  })
})
