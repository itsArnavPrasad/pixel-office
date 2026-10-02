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
import { consume, emptyTranscript, formatTokens, totalTokens } from '../src/transcript'

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
    { type: 'user', message: { role: 'user', content: 'fix the login test' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: "I'll run it first." }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'reminder' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/office</command-name>' } },
    { type: 'assistant', isSidechain: true, message: { id: 'm9', content: [{ type: 'text', text: 'subagent' }], usage: { output_tokens: 999 } } },
    { type: 'summary', summary: 'x' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n'

  test('reads conversation lines and counts each API message once', () => {
    const s = consume(emptyTranscript(), rows, rows.length)
    assert.deepEqual(s.lines, [
      { who: 'you', text: 'fix the login test' },
      { who: 'agent', text: "I'll run it first." },
      { who: 'tool', text: 'Bash(npm test)' },
    ])
    assert.deepEqual(s.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 })
    assert.equal(totalTokens(s.tokens), 135)
    assert.equal(s.offset, rows.length)
  })
  test('a line split across chunks is joined; junk lines are skipped', () => {
    const half = Math.floor(rows.length / 2)
    let s = consume(emptyTranscript(), 'not json\n', 9)
    s = consume(s, rows.slice(0, half), half)
    s = consume(s, rows.slice(half), rows.length - half)
    assert.equal(s.lines.length, 3)
    assert.equal(s.partial, '')
  })
  test('keeps only the last 12 lines', () => {
    const many = Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `msg ${i}` } })).join('\n') + '\n'
    const s = consume(emptyTranscript(), many, many.length)
    assert.equal(s.lines.length, 12)
    assert.equal(s.lines[0]!.text, 'msg 18')
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
  test('rejects junk, path tricks and oversize text', () => {
    for (const m of [null, 5, {}, { type: 'nuke' }, { type: 'jump', id: '../../etc' }, { type: 'send', id: 'a', text: '' },
      { type: 'send', id: 'a', text: 'x'.repeat(4001) }, { type: 'select', id: 7 }, { type: 'send', id: 'a b', text: 'x' }])
      assert.equal(parseFromWebview(m), null, JSON.stringify(m))
  })
})
