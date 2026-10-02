import { describe, expect, test } from 'claude-code/testing'

import type { AgentRecord } from '../types'
import { HOLD_MS, PRUNE_MS, byUrgency, newAgent, presence, reduce } from '../hooks/core/agent'
import { asPrompt, makeMessage, messageId, parseMessage, pendingFiles } from '../hooks/core/inbox'
import { assignDesks, hash, mergeRoster, parseRecord } from '../hooks/core/roster'
import { activityFor, describeCommand } from '../hooks/core/signals'
import { bubble, clean, firstSentence, redact, taskOf, truncate, wrap } from '../hooks/core/text'

const T = 1_759_400_000_000
const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({ ...newAgent('a1', T), ...over })
const agent0 = agent

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
    expect(wrap('$ abcdefgh', 6)).toEqual(['$ abcd', 'efgh'])
    expect(wrap('abcde abcdefgh', 6)).toEqual(['abcde', 'abcdef', 'gh'])
  })
})

describe('signals', () => {
  test('each tool reads as plain words; the raw detail is kept apart', () => {
    expect(activityFor('Bash', { command: 'npm test' })).toEqual({ state: 'typing', bubble: 'Running tests', detail: '$ npm test' })
    expect(activityFor('Read', { file_path: '/a/b/c.ts' })).toEqual({ state: 'reading', bubble: 'Reading c.ts', detail: '/a/b/c.ts' })
    expect(activityFor('Grep', { pattern: 'TODO' }).bubble).toBe('Searching for TODO')
    expect(activityFor('Edit', { file_path: '/r/src/x.ts' }).bubble).toBe('Editing x.ts')
    expect(activityFor('Write', { file_path: '/r/new.ts' }).bubble).toBe('Writing new.ts')
    expect(activityFor('WebFetch', { url: 'https://example.com/a' }).bubble).toBe('Reading example.com')
    expect(activityFor('Agent', { description: 'scan repo' })).toMatchObject({ state: 'delegating', bubble: 'Delegating: scan repo' })
    expect(activityFor('AskUserQuestion', { questions: [{ question: 'Which DB?' }] })).toMatchObject({ state: 'needs-you', bubble: 'Which DB?' })
    expect(activityFor('mcp__github__create_issue').bubble).toBe('Using github: create issue')
    expect(activityFor('SomethingNew').bubble).toBe('Using SomethingNew')
  })
  test('shell commands are named by what they are for', () => {
    const cases: [string, string][] = [
      ['cd "/x y" && npm test -- --runs=5 2>&1 | tail', 'Running tests'],
      ['CI=1 pnpm run test', 'Running tests'],
      ['pytest -q tests/', 'Running tests'],
      ['npx tsc -p .', 'Checking types and lint'],
      ['npm run build', 'Building'],
      ['npm i -D esbuild', 'Installing packages'],
      ['pnpm add -D vitest', 'Installing packages'],
      ['git add -A && git commit -m x', 'Using git'],
      ['git commit -m "fix"', 'Committing'],
      ['git push origin main', 'Pushing'],
      ['git status --short', 'Reviewing changes'],
      ['gh pr create --fill', 'Working on a pull request'],
      ['curl -s https://api.x', 'Calling a URL'],
      ['ls -la src', 'Looking through the code'],
      ['grep -rn TODO .', 'Looking through the code'],
      ['mkdir -p a && cp x a', 'Moving files around'],
      ['node scripts/preview.mjs', 'Running a script'],
      ['frobnicate --all', 'Running a command'],
      ['', 'Running a command'],
    ]
    for (const [cmd, want] of cases) expect([cmd, describeCommand(cmd)]).toEqual([cmd, want])
  })
  test('bash details redact secrets and ignore non-string input', () => {
    expect(activityFor('Bash', { command: 'GITHUB_TOKEN=abc gh pr list' })).toMatchObject({ bubble: 'Working on a pull request', detail: '$ GITHUB_TOKEN=*** gh pr list' })
    expect(activityFor('Bash', { command: 42 }).bubble).toBe('Running a command')
  })
})

describe('agent reducer', () => {
  test('desk title: a prompt that names the work retitles, short replies and commands keep it; yours wins until cleared', () => {
    expect(taskOf('[Sent to you through Pixel Office]\n\nWrite tests for the auth controller. Then lint.')).toBe('Write tests for the auth controller.')
    for (const t of ['yes', 'go on', '/office', '<command-name>x</command-name>']) expect(taskOf(t)).toBe('')
    let a = reduce(agent({ cwd: '/r' }), { kind: 'prompt', text: 'fix the login redirect bug' }, T)
    a = reduce(a, { kind: 'prompt', text: 'ok' }, T + 1)
    expect(a.task).toBe('fix the login redirect bug')
    a = reduce(a, { kind: 'title', text: '  Auth  work ' }, T + 2)
    expect(a.title).toBe('Auth work')
    expect(reduce(a, { kind: 'start', name: 'n', cwd: '/r', character: 'dev-1' }, T + 3)).toMatchObject({ title: 'Auth work', task: 'fix the login redirect bug' })
    expect(reduce(a, { kind: 'title', text: '' }, T + 4).title).toBe('')
  })
  test('start → arriving, then idle after the hold; a restart keeps joinedAt', () => {
    expect(reduce(agent({ joinedAt: T - 999 }), { kind: 'start', name: 'x', cwd: '/x', character: 'dev-1' }, T).joinedAt).toBe(T - 999)
    // state saved before joinedAt existed
    expect(reduce(agent({ joinedAt: undefined as never }), { kind: 'start', name: 'x', cwd: '/x', character: 'dev-1' }, T).joinedAt).toBe(T)
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
  test('edits remember the last 8 absolute files, newest first, deduped', () => {
    let a = agent()
    for (const f of ['/r/a.ts', '/r/b.ts', '/r/a.ts']) a = reduce(a, { kind: 'tool', tool: 'Edit', input: { file_path: f } }, T)
    expect(a.files).toEqual(['/r/a.ts', '/r/b.ts'])
    a = reduce(a, { kind: 'tool', tool: 'Read', input: { file_path: '/r/c.ts' } }, T)
    a = reduce(a, { kind: 'tool', tool: 'Write', input: { file_path: 'relative.ts' } }, T)
    expect(a.files).toEqual(['/r/a.ts', '/r/b.ts'])
    for (let i = 0; i < 12; i++) a = reduce(a, { kind: 'tool', tool: 'NotebookEdit', input: { notebook_path: `/n/${i}.ipynb` } }, T)
    expect(a.files.length).toBe(8)
    expect(a.files[0]).toBe('/n/11.ipynb')
  })
  test('start records the pid and keeps files', () => {
    const a = reduce(agent({ files: ['/x'] }), { kind: 'start', name: 'n', cwd: '/c', character: 'dev-1', pid: 4242 }, T)
    expect([a.pid, a.files]).toEqual([4242, ['/x']])
  })
  test('a second needs-you keeps the first wording and wait start', () => {
    const a = reduce(agent({ isBusy: true }), { kind: 'needs-you', text: 'Allow Bash: rm -rf dist?' }, T)
    const b = reduce(a, { kind: 'needs-you', text: 'Claude needs your permission to use Bash' }, T + 50)
    expect([b.bubble, b.since, b.heartbeat]).toEqual(['Allow Bash: rm -rf dist?', T, T + 50])
  })
  test('an interrupted turn stops, a failed one is stressed, neither says Done', () => {
    expect(reduce(agent({ isBusy: true }), { kind: 'turn-done', text: '', reason: 'aborted' }, T)).toMatchObject({ state: 'idle', bubble: 'Stopped.', isBusy: false })
    expect(reduce(agent({ isBusy: true }), { kind: 'turn-done', text: '', reason: 'error' }, T)).toMatchObject({ state: 'stressed', isBusy: false })
  })
  test('tool-done while idle changes nothing', () => {
    const a = agent({ state: 'idle' })
    expect(reduce(a, { kind: 'tool-done', isError: false }, T)).toBe(a)
  })
  test('turn-done → done with the first sentence, and it stays done', () => {
    const a = reduce(agent({ isBusy: true }), { kind: 'turn-done', text: 'Fixed the auth bug. Details…' }, T)
    expect(a).toMatchObject({ state: 'done', bubble: 'Fixed the auth bug.', lastLine: 'Fixed the auth bug.', isBusy: false })
    expect(reduce(a, { kind: 'tick' }, T + 60 * HOLD_MS)).toMatchObject({ state: 'done', bubble: 'Fixed the auth bug.' })
  })
  test('interns never go negative; end → leaving', () => {
    const a = reduce(agent(), { kind: 'interns', count: -1 }, T)
    expect(a.interns).toBe(0)
    expect(reduce(reduce(a, { kind: 'interns', count: 2 }, T), { kind: 'end' }, T)).toMatchObject({ state: 'leaving', interns: 0 })
  })
  test('since only moves when the state or bubble changes', () => {
    const a = agent({ state: 'typing', bubble: 'Looking through the code', since: T })
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
    expect(parseRecord(JSON.stringify({ ...good, joinedAt: undefined }))).toBe(null)
    // an older mod's record, without pid / files, still parses with defaults
    const { pid: _p, files: _f, ...old } = good
    expect(parseRecord(JSON.stringify(old))).toEqual({ ...good, pid: 0, files: [] })
    expect(parseRecord(JSON.stringify({ ...good, files: ['/ok', 5, 'x'.repeat(5000)] }))!.files).toEqual(['/ok'])
    expect(parseRecord(JSON.stringify({ ...good, id: '' }))).toBe(null)
    expect(parseRecord(JSON.stringify({ ...good, name: 'x'.repeat(101) }))).toBe(null)
  })
  test('mergeRoster prunes, marks away, dedupes and prefers me', () => {
    const agent = (over: Partial<AgentRecord> = {}) => agent0({ cwd: '/r/web', ...over })
    const me = agent({ id: 'me', joinedAt: T })
    const seats = mergeRoster([
      agent({ id: 'unstarted', cwd: '' }),
      agent({ id: 'b', joinedAt: T + 2, heartbeat: T }),
      agent({ id: 'b', joinedAt: T + 2, heartbeat: T - 5 }),
      agent({ id: 'old', heartbeat: T - PRUNE_MS - 10 }),
      agent({ id: 'me', name: 'stale copy', heartbeat: T - 99 }),
      agent({ id: 'c', joinedAt: T + 1, heartbeat: T - 30_000 }),
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
  test('pendingFiles: not yet delivered, sorted, deduped, only message files', () => {
    const a = `${messageId(T, 0.1)}.json`
    const b = `${messageId(T + 5, 0.1)}.json`
    expect(pendingFiles([b, a, a, 'notes.txt', 'x.json'], [])).toEqual([a, b])
    expect(pendingFiles([a, b], [a.slice(0, -5)])).toEqual([b])
    // an older id arriving after a newer one was delivered is still delivered (no cursor to fall behind)
    expect(pendingFiles([a], [b.slice(0, -5)])).toEqual([a])
  })
  test('asPrompt: your words pass through, agent messages are labelled', () => {
    expect(asPrompt(makeMessage('you', 'you', 'run tests', T, 0)!)).toBe('[Sent to you through Pixel Office]\n\nrun tests')
    expect(asPrompt(makeMessage('s2', 'web', 'hi', T, 0)!)).toContain('"web"')
  })
})
