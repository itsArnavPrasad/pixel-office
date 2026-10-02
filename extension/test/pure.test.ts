import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { newAgent } from '../../pixel-office/hooks/core/agent'
import type { Seat } from '../../pixel-office/hooks/core/roster'
import { collisions } from '../src/collisions'
import { countUntracked, describeChanges, parseShortstat } from '../src/git'
import { parsePs, shellAncestor } from '../src/jump'
import { parsePeer, uiLeader } from '../src/peers'
import { parseFromWebview } from '../src/protocol'
import { addPluginDir, isEnabled, removePluginDir } from '../src/setup'
import { blocks, consume, describeTokens, emptyTranscript, formatTokens, KEEP_ENTRIES, totalTokens, type Entry } from '../src/transcript'
import { clock, esc, markdown, tildify } from '../webview/format'

const T = 1_790_000_000_000
const seat = (id: string, over: Partial<Seat> = {}): Seat => ({ ...newAgent(id, T), name: id, isAway: false, isMe: false, ...over })

describe('collisions', () => {
  test('two live agents on one file collide; away and leaving agents do not', () => {
    const got = collisions([
      seat('web', { files: ['/r/auth.ts', '/r/a.ts'] }),
      seat('api', { files: ['/r/auth.ts'] }),
      seat('ghost', { files: ['/r/a.ts'], isAway: true }),
      seat('bye', { files: ['/r/a.ts'], state: 'leaving' }),
      seat('solo', { files: ['/r/z.ts', '/r/z.ts'] }),
    ])
    assert.deepEqual(got, [{ file: '/r/auth.ts', ids: ['web', 'api'], names: ['web', 'api'] }])
  })
  test('no files, no collisions', () => assert.deepEqual(collisions([seat('a'), seat('b')]), []))
})

describe('transcript', () => {
  const rows = [
    { type: 'user', timestamp: '2026-10-03T10:00:00Z', message: { role: 'user', content: 'fix the login test' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: "I'll run it first." }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }], is_error: false }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nobody', content: 'orphan' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'reminder' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/office</command-name>' } },
    { type: 'assistant', isSidechain: true, message: { id: 'm9', content: [{ type: 'text', text: 'subagent' }], usage: { output_tokens: 999 } } },
    { type: 'summary', summary: 'x' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n'

  test('reads the conversation, pairs tool calls with results, counts each API message once', () => {
    const s = consume(emptyTranscript(), rows, rows.length)
    assert.deepEqual(s.entries.map(e => [e.kind, e.text, e.tool, e.output, e.isError]), [
      ['you', 'fix the login test', undefined, undefined, undefined],
      ['agent', "I'll run it first.", undefined, undefined, undefined],
      ['tool', 'npm test', 'Bash', 'ok', false],
    ])
    assert.equal(s.entries[0]!.at, Date.parse('2026-10-03T10:00:00Z'))
    assert.match(s.entries[2]!.input!, /"command": "npm test"/)
    assert.deepEqual(s.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 })
    assert.equal(describeTokens(s.tokens), '35 new · 100 cached')
    assert.equal(totalTokens(s.tokens), 135)
    assert.equal(s.offset, rows.length)
  })
  test('a line split across chunks is joined; junk lines are skipped', () => {
    const half = Math.floor(rows.length / 2)
    let s = consume(emptyTranscript(), 'not json\n', 9)
    s = consume(s, rows.slice(0, half), half)
    s = consume(s, rows.slice(half), rows.length - half)
    assert.equal(s.entries.length, 3)
    assert.equal(s.partial, '')
  })
  test(`keeps only the last ${KEEP_ENTRIES} entries`, () => {
    const many = Array.from({ length: KEEP_ENTRIES + 30 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `msg ${i}` } })).join('\n') + '\n'
    const s = consume(emptyTranscript(), many, many.length)
    assert.equal(s.entries.length, KEEP_ENTRIES)
    assert.equal(s.entries[0]!.text, 'msg 30')
  })
  test('a failed tool is marked, and huge output is capped', () => {
    const t = [
      { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'make' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'E'.repeat(9000), is_error: true }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n'
    const e = consume(emptyTranscript(), t, t.length).entries[0]!
    assert.equal(e.isError, true)
    assert.ok(e.output!.length < 4100 && e.output!.includes('more characters'))
  })
  test('formatTokens', () => {
    assert.deepEqual([0, 999, 1500, 12_345, 2_500_000].map(formatTokens), ['0', '999', '1.5k', '12k', '2.5M'])
  })
})

describe('git', () => {
  test('parses shortstat in all its shapes', () => {
    assert.deepEqual(parseShortstat(' 3 files changed, 120 insertions(+), 30 deletions(-)\n'), { files: 3, added: 120, removed: 30 })
    assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, added: 1, removed: 0 })
    assert.deepEqual(parseShortstat(' 2 files changed, 4 deletions(-)'), { files: 2, added: 0, removed: 4 })
    assert.deepEqual(parseShortstat(''), { files: 0, added: 0, removed: 0 })
  })
  test('untracked count and description', () => {
    assert.equal(countUntracked('?? a.ts\n M b.ts\n?? c/\n'), 2)
    assert.equal(describeChanges({ files: 4, added: 120, removed: 30 }), '+120 −30 · 4 files')
    assert.equal(describeChanges({ files: 1, added: 2, removed: 0 }), '+2 −0 · 1 file')
    assert.equal(describeChanges({ files: 0, added: 0, removed: 0 }), 'no changes')
  })
})

describe('jump', () => {
  const parents = parsePs('  1     0\n  500   1\n  600 500\n  700 600\n  800 700\n garbage\n')
  test('parsePs', () => assert.equal(parents.get(700), 600))
  test('finds the shell above claude, or none', () => {
    assert.equal(shellAncestor(800, new Set([600]), parents), 600)
    assert.equal(shellAncestor(600, new Set([600]), parents), 600)
    assert.equal(shellAncestor(800, new Set([999]), parents), null)
    assert.equal(shellAncestor(0, new Set([0]), parents), null)
    assert.equal(shellAncestor(800, new Set([500]), parents, 1), null)
  })
  test('a cycle in the table cannot loop forever', () => {
    assert.equal(shellAncestor(5, new Set([42]), new Map([[5, 6], [6, 5]])), null)
  })
})

describe('setup', () => {
  const DIR = '/Users/u/.claude/pixel-office/mod'
  test('adds to empty or missing settings', () => {
    const r = addPluginDir('', DIR)
    assert.ok('text' in r && r.changed)
    assert.deepEqual(JSON.parse(r.text), { env: { CLAUDE_CODE_PLUGIN_DIRS: DIR } })
  })
  test("carries the shell's own plugin dirs when settings has none", () => {
    const r = addPluginDir('{}', DIR, '/from/shell:' + DIR)
    assert.ok('text' in r)
    assert.equal(JSON.parse(r.text).env.CLAUDE_CODE_PLUGIN_DIRS, `/from/shell:${DIR}`)
  })
  test('keeps every other setting and directory; idempotent', () => {
    const before = JSON.stringify({ model: 'opus', env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '/a:/b' }, hooks: { Stop: [] } })
    const r = addPluginDir(before, DIR)
    assert.ok('text' in r)
    assert.deepEqual(JSON.parse(r.text), { model: 'opus', env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: `/a:/b:${DIR}` }, hooks: { Stop: [] } })
    const again = addPluginDir(r.text, DIR)
    assert.ok('text' in again && !again.changed && again.text === r.text)
    assert.ok(isEnabled(r.text, DIR))
  })
  test('remove takes only ours and tidies an emptied env', () => {
    const r = removePluginDir(JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: `/a:${DIR}` } }), DIR)
    assert.ok('text' in r)
    assert.deepEqual(JSON.parse(r.text), { env: { CLAUDE_CODE_PLUGIN_DIRS: '/a' } })
    const r2 = removePluginDir(JSON.stringify({ x: 1, env: { CLAUDE_CODE_PLUGIN_DIRS: DIR } }), DIR)
    assert.ok('text' in r2)
    assert.deepEqual(JSON.parse(r2.text), { x: 1 })
    const r3 = removePluginDir('{"x":1}', DIR)
    assert.ok('text' in r3 && !r3.changed)
  })
  test('malformed settings are reported, never rewritten', () => {
    for (const bad of ['{ "a": 1, }', '[1]', '"str"', JSON.stringify({ env: [] }), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 5 } })]) {
      assert.ok('error' in addPluginDir(bad, DIR), bad)
      assert.ok('error' in removePluginDir(bad, DIR), bad)
      assert.equal(isEnabled(bad, DIR), false)
    }
  })
  test('a settings key named "error" is just a setting', () => {
    const r = addPluginDir('{"error":"mine"}', DIR)
    assert.ok('text' in r && JSON.parse(r.text).error === 'mine')
  })
})

describe('peers', () => {
  test('leader is the earliest fresh window', () => {
    const p = (id: string, startedAt: number, heartbeat = T) => ({ v: 1 as const, id, startedAt, heartbeat })
    assert.equal(uiLeader([p('b', 5), p('a', 9), p('old', 1, T - 60_000)], T), 'b')
    assert.equal(uiLeader([p('b', 5), p('a', 5)], T), 'a')
    assert.equal(uiLeader([], T), null)
  })
  test('parsePeer validates', () => {
    assert.ok(parsePeer(JSON.stringify({ v: 1, id: 'w-1', startedAt: 1, heartbeat: 2 })))
    assert.equal(parsePeer(JSON.stringify({ v: 1, id: '../x', startedAt: 1, heartbeat: 2 })), null)
    assert.equal(parsePeer('nope'), null)
  })
})

describe('protocol', () => {
  test('accepts well-formed messages', () => {
    assert.deepEqual(parseFromWebview({ type: 'ready' }), { type: 'ready' })
    assert.deepEqual(parseFromWebview({ type: 'select', id: null }), { type: 'select', id: null })
    assert.deepEqual(parseFromWebview({ type: 'send', id: 'a2cf-1', text: 'hi', extra: 1 }), { type: 'send', id: 'a2cf-1', text: 'hi' })
  })
  test('rooms are absolute paths or null', () => {
    assert.deepEqual(parseFromWebview({ type: 'newAgent', room: '/Users/u/code/web' }), { type: 'newAgent', room: '/Users/u/code/web' })
    assert.deepEqual(parseFromWebview({ type: 'standup', room: null }), { type: 'standup', room: null })
    assert.deepEqual(parseFromWebview({ type: 'standup' }), { type: 'standup', room: null })
    assert.equal(parseFromWebview({ type: 'newAgent', room: 'relative/x' }), null)
    assert.equal(parseFromWebview({ type: 'newAgent', room: '/a\0b' }), null)
    assert.deepEqual(parseFromWebview({ type: 'openTranscript', id: 'abc' }), { type: 'openTranscript', id: 'abc' })
  })
  test('rejects junk, path tricks and oversize text', () => {
    for (const m of [null, 5, {}, { type: 'nuke' }, { type: 'jump', id: '../../etc' }, { type: 'send', id: 'a', text: '' },
      { type: 'send', id: 'a', text: 'x'.repeat(4001) }, { type: 'select', id: 7 }, { type: 'send', id: 'a b', text: 'x' }])
      assert.equal(parseFromWebview(m), null, JSON.stringify(m))
  })
})

describe('console formatting', () => {
  test('markdown escapes everything, then renders code, bold and fences', () => {
    assert.equal(markdown('<img src=x onerror=alert(1)>'), '&#60;img src=x onerror=alert(1)&#62;')
    assert.equal(markdown('run `npm test` **now**'), 'run <code>npm test</code> <b>now</b>')
    assert.equal(markdown('a\n```ts\nconst x = "<b>"\n```\nb'), 'a<br><pre class="code" data-lang="ts"><code>const x = &#34;&#60;b&#62;&#34;</code></pre><br>b')
    assert.equal(markdown('[docs](javascript:alert(1))'), 'docs')
    assert.equal(esc(`"'&`), '&#34;&#39;&#38;')
  })
  test('clock and tildify', () => {
    const now = new Date(2026, 9, 3, 15, 0, 0).getTime()
    assert.equal(clock(new Date(2026, 9, 3, 9, 5, 7).getTime(), now), '09:05:07')
    assert.equal(clock(new Date(2026, 9, 1, 9, 5).getTime(), now), 'Oct 1 09:05')
    assert.equal(clock(0, now), '')
    assert.equal(tildify('/Users/me/code/web', '/Users/me'), '~/code/web')
    assert.equal(tildify('/Users/meme/x', '/Users/me'), '/Users/meme/x')
  })
})

describe('console blocks and plan', () => {
  const tool = (t: string, over: Partial<Entry> = {}): Entry => ({ kind: 'tool', tool: t, text: '', at: 1, output: 'ok', ...over })
  const msg = (kind: 'you' | 'agent', text: string): Entry => ({ kind, text, at: 1 })
  test('runs of tool calls fold into one summarised block, messages stay', () => {
    const b = blocks([msg('you', 'go'), tool('Read'), tool('Read'), tool('Edit'), tool('Bash', { isError: true }), msg('agent', 'done'), tool('Bash', { output: undefined })])
    assert.deepEqual(b.map(x => x.kind), ['message', 'actions', 'message', 'actions'])
    const first = b[1] as Extract<typeof b[number], { kind: 'actions' }>
    assert.equal(first.summary, '4 actions · 2 reads, 1 edit, 1 command')
    assert.equal(first.failed, 1)
    const last = b[3] as Extract<typeof b[number], { kind: 'actions' }>
    assert.deepEqual([last.summary, last.running], ['1 action · 1 command', 1])
  })
  test('unknown and MCP tools are counted as other; aliases merge', () => {
    const b = blocks([tool('mcp__github__create_issue'), tool('MultiEdit'), tool('Edit'), tool('Glob')])
    assert.equal((b[0] as { summary: string }).summary, '4 actions · 1 other, 2 edits, 1 search')
  })
  test('the latest TodoWrite becomes the plan; your latest prompt the task', () => {
    const rows = [
      { type: 'user', message: { content: 'first ask' } },
      { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [
        { content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }, { content: 'bad', status: 'weird' }, { content: 'three', status: 'pending' },
      ] } }] } },
      { type: 'user', message: { content: 'second ask' } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n'
    const s = consume(emptyTranscript(), rows, rows.length)
    assert.equal(s.task, 'second ask')
    assert.deepEqual(s.plan, [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { text: 'three', status: 'pending' }])
  })
})
