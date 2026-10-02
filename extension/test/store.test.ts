import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { newAgent } from '../../pixel-office/hooks/core/agent'
import { parseMessage } from '../../pixel-office/hooks/core/inbox'
import { OfficeStore } from '../src/store'

let root = ''
const NOW = Date.now()

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'pixel-office-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

const put = (id: string, over = {}) =>
  writeFile(join(root, 'agents', `${id}.json`), JSON.stringify({ ...newAgent(id, NOW), name: id, heartbeat: NOW, ...over }))

describe('OfficeStore over a real folder', () => {
  test('an empty or missing folder is an empty office', async () => {
    const s = await new OfficeStore(join(root, 'nope')).read(NOW)
    assert.deepEqual(s, { seats: [], standup: null, peers: [] })
  })

  test('reads agents, skips junk and mismatched names, marks away', async () => {
    await mkdir(join(root, 'agents'), { recursive: true })
    await put('web', { state: 'needs-you', joinedAt: NOW - 10 })
    await put('api', { heartbeat: NOW - 30_000, joinedAt: NOW - 5 })
    await writeFile(join(root, 'agents', 'junk.json'), '{broken')
    await writeFile(join(root, 'agents', 'liar.json'), JSON.stringify({ ...newAgent('someone-else', NOW) }))
    const s = await new OfficeStore(root).read(NOW)
    assert.deepEqual(s.seats.map(x => [x.id, x.isAway]), [['web', false], ['api', true]])
  })

  test('send writes one valid inbox message; bad targets and empty text are refused', async () => {
    const store = new OfficeStore(root)
    assert.equal(await store.send('web', '  please add tests  ', NOW), true)
    assert.equal(await store.send('../evil', 'x', NOW), false)
    assert.equal(await store.send('web', '   ', NOW), false)
    const files = await readdir(join(root, 'inbox', 'web'))
    assert.equal(files.length, 1)
    const m = parseMessage(await readFile(join(root, 'inbox', 'web', files[0]!), 'utf8'))
    assert.deepEqual([m?.from, m?.text, `${m?.id}.json`], ['you', 'please add tests', files[0]])
  })

  test('a standup request shows with its answers in answer order', async () => {
    const store = new OfficeStore(root)
    const id = await store.requestStandup('editor', null, NOW)
    await mkdir(join(root, 'standup', id), { recursive: true })
    const ans = (who: string, at: number) => ({ v: 1, id: who, name: who, character: 'dev-1', done: `${who} done`, next: '', blocked: '', at })
    await writeFile(join(root, 'standup', id, 'web.json'), JSON.stringify(ans('web', NOW + 2)))
    await writeFile(join(root, 'standup', id, 'api.json'), JSON.stringify(ans('api', NOW + 1)))
    await writeFile(join(root, 'standup', id, 'x.json'), JSON.stringify(ans('not-x', NOW)))
    const s = await store.read(NOW + 1000)
    assert.equal(s.standup?.request.by, 'editor')
    assert.deepEqual(s.standup?.answers.map(a => a.id), ['api', 'web'])
    assert.equal((await store.read(NOW + 11 * 60_000)).standup, null)
  })

  test('a room standup carries its room; a spawn ticket parses for the mod', async () => {
    const { parseTicket } = await import('../../pixel-office/hooks/core/rooms')
    const store = new OfficeStore(root)
    const id = await store.requestStandup('editor', '/r/web', NOW)
    assert.equal(JSON.parse(await readFile(join(root, 'standup', `${id}.json`), 'utf8')).room, '/r/web')
    const t = await store.spawn('/r/web', 'tests-bot', 'write tests', 'dev-3', NOW)
    assert.deepEqual(parseTicket(await readFile(join(root, 'spawn', `${t.id}.json`), 'utf8')), t)
  })

  test('heartbeat sweeps window files a crash left behind', async () => {
    const { utimes } = await import('node:fs/promises')
    await mkdir(join(root, 'ui'), { recursive: true })
    const stale = join(root, 'ui', 'w-dead.json')
    await writeFile(stale, '{}')
    const old = new Date(Date.now() - 5 * 60_000)
    await utimes(stale, old, old)
    await new OfficeStore(root, NOW, 'w-live').heartbeat(NOW, { isFocused: false, isNotifying: true })
    const left = await readdir(join(root, 'ui'))
    assert.ok(!left.includes('w-dead.json') && left.includes('w-live.json'))
    assert.equal(JSON.parse(await readFile(join(root, 'ui', 'w-live.json'), 'utf8')).isFocused, false)
    await rm(join(root, 'ui', 'w-live.json'))
  })

  test('heartbeat announces the window; leave removes it', async () => {
    const store = new OfficeStore(root, NOW, 'w-test')
    await store.heartbeat(NOW + 5)
    let s = await store.read(NOW)
    assert.deepEqual(s.peers, [{ v: 1, id: 'w-test', startedAt: NOW, heartbeat: NOW + 5, isFocused: true, isNotifying: true }])
    await store.leave()
    s = await store.read(NOW)
    assert.deepEqual(s.peers, [])
    assert.deepEqual((await readdir(join(root, 'ui'))).filter(n => n.endsWith('.tmp')), [])
  })
})
