import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import type { AgentRecord } from '../types'
import { newAgent } from '../hooks/core/agent'
import { makeMessage, messageId } from '../hooks/core/inbox'

const T = 1_759_400_000_000
const HOME = '/home/u'
const ROOT = `${HOME}/.claude/pixel-office`
const ME = 'me-session'
const MY_FILE = `${ROOT}/agents/${ME}.json`

/** The world beneath the mod: files, prompts, toasts and status in memory. */
function world(on: On, opts: { store?: Record<string, unknown> } = {}) {
  const knobs = { id: ME, rmFails: false, runs: [] as string[][] }
  const files = new Map<string, string>()
  const prompts: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const notified: string[][] = []
  const forks: string[] = []
  const sound = { chimes: 0 }
  const fork = { reply: 'Done: fixed login\nNext: add tests\nBlocked: nothing' as string | null }
  const history: { role: string; text: string; toolUses: { tool: string }[] }[] = []
  const completions: string[] = []
  const statuses: string[] = []
  const clock = mock.clock(on, { now: T })
  // the plugin's store, in a Map the tests can read
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', ($, e) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }) as never)
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  mock.env(on, { HOME })
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const ok = (value?: unknown) => ({ value }) as never
  on('fs.write', ($, e) => (files.set(e.path, e.text), ok()))
  on('fs.exists', ($, e) => ok(files.has(e.path)))
  on('fs.read', ($, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return ok(t)
  })
  on('fs.list', ($, e) => {
    const out = new Map<string, { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [p, t] of files) {
      if (!p.startsWith(`${e.path}/`)) continue
      const rest = p.slice(e.path.length + 1)
      const name = rest.split('/')[0]!
      out.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file', size: t.length, mtimeMs: clock.now(), isLink: false })
    }
    return ok([...out.values()])
  })
  on('process.run', ($, e) => {
    knobs.runs.push([...e.argv])
    if (e.argv[0] === 'rm' && knobs.rmFails) return ok({ exitCode: 1, stdout: '', stderr: 'denied' })
    if (e.argv[0] === 'rm') for (const p of e.argv.slice(3)) for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
    if (e.argv[0] === 'osascript') notified.push([...e.argv.slice(-2)])
    if (e.argv[0] === 'sh') return ok({ exitCode: 0, stdout: '31337\n', stderr: '' })
    if (e.argv[0] === 'mv') {
      const [from, to] = e.argv.slice(-2) as [string, string]
      if (!files.has(from)) return ok({ exitCode: 1, stdout: '', stderr: 'gone' })
      files.set(to, files.get(from)!), files.delete(from)
    }
    return ok({ exitCode: 0, stdout: '', stderr: '' })
  })
  on('session.id', () => ok(knobs.id))
  on('session.repo', () => ok(null))
  on('session.messages', () => ok(history))
  on('session.model', () => ok('claude-opus-5-5'))
  on('model.complete', ($, e) => (completions.push(e.prompt), ok({ isAnswered: true, text: 'Done: shipped the rooms\nNext: polish\nBlocked: none', usage: {} })))
  on('prompt.submit', ($, e) => (prompts.push(e.text), { text: e.text }))
  on('ui.status', ($, e) => (statuses.push(JSON.stringify(e)), ok()))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('command.register', ($, e) => ok({ command: e.name }))
  on('ui.toast', ($, e) => (toasts.push(JSON.stringify(e)), ok()))
  for (const n of ['ui.log', 'ui.close', 'ui.invalidate'] as const) on(n, () => ok())
  on('audio.play', () => (sound.chimes++, ok()))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return ok(fork.reply === null ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: fork.reply, usage: {} })
  })
  on('ui.open', ($, e) => (opened.push(e.id), ok({})))
  on('ui.blit', () => ok({}))
  on('ui.render', () => h(Fragment, null) as never) // the engine's own drawing, as nothing
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  const mine = (): AgentRecord => JSON.parse(files.get(MY_FILE) ?? 'null')
  const put = (rec: AgentRecord) => files.set(`${ROOT}/agents/${rec.id}.json`, JSON.stringify({ ...rec, cwd: rec.cwd || '/work/web' }))
  return { files, prompts, opened, toasts, notified, forks, fork, history, completions, sound, statuses, clock, mine, put, knobs, store }
}

async function boot($: Engine, cwd = '/work/api-server') {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

const PANE_PROPS = {
  title: 'Pixel Office', isFocused: true, bodyColumns: 80, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40, contentRows: 40 }, view: {},
}

describe('presence', () => {
  test('session.start writes this session into the office', async ($, on) => {
    const w = world(on)
    await boot($)
    expect(w.mine()).toMatchObject({ id: ME, name: 'api-server', state: 'arriving', v: 1, pid: 31337, files: [] })
  })

  test('a tool call acts out, then settles back to thinking', async ($, on) => {
    const w = world(on)
    let during: AgentRecord | null = null
    on('tool.call', () => {
      during = w.mine()
      return { result: { stdout: 'ok', stderr: '', interrupted: false }, isError: false } as never
    })
    await boot($)
    await $.prompt.submit({ text: 'run the tests' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    expect(during!).toMatchObject({ state: 'typing', bubble: 'Running tests', detail: '$ npm test' })
    expect(w.mine()).toMatchObject({ state: 'thinking', tools: 1, turns: 1 })
  })

  test('a permission request raises a hand', async ($, on) => {
    const w = world(on)
    await boot($)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as never)
    expect(w.mine()).toMatchObject({ state: 'needs-you', bubble: 'Allow Bash: rm -rf build?' })
  })

  test('turn.complete shows the first sentence, then idles', async ($, on) => {
    const w = world(on)
    await boot($)
    await $.turn.complete({ answer: 'Fixed the auth bug. More words.', reason: 'answer', durationMs: 5, isAborted: false, turnId: 't1' } as never)
    expect(w.mine()).toMatchObject({ state: 'done', bubble: 'Fixed the auth bug.' })
    await w.clock.advance(4000)
    expect(w.mine().state).toBe('idle')
  })

  test('others are polled in; a crowd shows in the status line', async ($, on) => {
    const w = world(on)
    await boot($)
    w.put({ ...newAgent('other', T), name: 'web', state: 'needs-you', bubble: 'Which DB?' })
    w.files.set(`${ROOT}/agents/junk.json`, '{broken')
    await w.clock.advance(1100)
    expect(w.statuses.some(s => s.includes('2 in the office') && s.includes('1 needs you'))).toBe(true)
  })
})

describe('inbox', () => {
  test('a message for this session becomes exactly one prompt', async ($, on) => {
    const w = world(on)
    await boot($)
    const m = makeMessage('you', 'you', 'also update the README', T, 0.5)!
    w.files.set(`${ROOT}/inbox/${ME}/${m.id}.json`, JSON.stringify(m))
    await w.clock.advance(1100)
    await w.clock.advance(1100)
    expect(w.prompts.filter(p => p.endsWith('also update the README')).length).toBe(1)
    expect(w.files.has(`${ROOT}/inbox/${ME}/${m.id}.json`)).toBe(false)
  })

  test('a malformed message is dropped, not delivered', async ($, on) => {
    const w = world(on)
    await boot($)
    w.files.set(`${ROOT}/inbox/${ME}/0001759400000000-abcdef.json`, '{"v":1,"text":""}')
    await w.clock.advance(1100)
    expect(w.prompts.length).toBe(0)
  })
})

describe('pane', () => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as RenderSurface[]) {
    test(`draws the office and name chips on ${surface}`, async ($, on) => {
      const w = world(on)
      await boot($)
      w.put({ ...newAgent('other', T), name: 'web', state: 'typing', bubble: '$ ls', cwd: '/work/api-server', room: '/work/api-server' })
      w.put({ ...newAgent('far', T), name: 'docs', cwd: '/work/docs', room: '/work/docs' })
      await w.clock.advance(1100)
      const ui = await $.ui.mount({ plugin: 'pixel-office', surface, component: 'Pane', props: PANE_PROPS, requestId: 'pixel-office' })
      expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
      expect(await ui.find({ key: 'chip-other' })).toBeDefined()
      expect(await ui.find({ key: `chip-${ME}`, text: /api-server \(here\)/ })).toBeDefined()
      expect(await ui.find({ key: 'chip-far' })).toBeUndefined() // another room
      expect(await ui.find({ type: 'Text', text: /api-server · 2 here · 1 in other rooms/ })).toBeDefined()
      await ui.press({ key: 'chip-other' })
      expect(await ui.find({ type: 'Text', text: /\$ ls/ })).toBeDefined()
      if (surface !== 'mobile') {
        await (ui as unknown as { input: (t: { key: string; text: string }) => Promise<unknown> }).input({ key: 'reply', text: 'please add tests' })
        const sent = [...w.files.entries()].filter(([p]) => p.startsWith(`${ROOT}/inbox/other/`))
        expect(sent.length).toBe(1)
        expect(JSON.parse(sent[0]![1])).toMatchObject({ v: 1, from: 'you', text: 'please add tests' })
      }
      await ui.press({ key: 'close' })
      expect(await ui.find({ key: 'reply' })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('/office opens the pane; name and look persist', async ($, on) => {
    const w = world(on)
    await boot($)
    await $.command.run({ command: 'office', args: '' } as never)
    expect(w.opened).toEqual(['pixel-office'])
    await $.command.run({ command: 'office', args: 'name Ada' } as never)
    expect(w.mine().name).toBe('Ada')
    await $.command.run({ command: 'office', args: 'look dev-5' } as never)
    expect(w.mine().character).toBe('dev-5')
  })
})

const BAND_PROPS = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10, contentRows: 10 }, view: {},
}

describe('attention queue', () => {
  test('the leader chimes and notifies once per episode, then reminds once', async ($, on) => {
    const w = world(on)
    await boot($)
    w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Allow Bash: rm -rf dist?' })
    await w.clock.advance(1100)
    expect(w.notified).toEqual([['Allow Bash: rm -rf dist?', '❗ web needs you']])
    expect(w.sound.chimes).toBe(1)
    expect(w.toasts.some(t => t.includes('web needs you'))).toBe(true)
    await w.clock.advance(5000)
    expect([w.notified.length, w.sound.chimes]).toEqual([1, 1])
    // keep the other session's heartbeat fresh while it waits past the reminder
    for (let i = 0; i < 19; i++) {
      w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Allow Bash: rm -rf dist?', heartbeat: w.clock.now() })
      await w.clock.advance(10_000)
    }
    expect(w.notified.length).toBe(2)
    expect(w.notified[1]![1]).toContain('still waiting')
    expect(w.sound.chimes).toBe(2)
  })

  test('an open editor window takes over the chime and notification', async ($, on) => {
    const w = world(on)
    await boot($)
    w.files.set(`${ROOT}/ui/window-1.json`, JSON.stringify({ v: 1, isFocused: true, isNotifying: true }))
    w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Which DB?' })
    await w.clock.advance(1100)
    expect([w.notified.length, w.sound.chimes]).toEqual([0, 0])
    expect(w.toasts.some(t => t.includes('web needs you'))).toBe(true)
  })

  test('a background editor window does not silence the OS notification', async ($, on) => {
    const w = world(on)
    await boot($)
    w.files.set(`${ROOT}/ui/window-1.json`, JSON.stringify({ v: 1, isFocused: false, isNotifying: true }))
    w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Which DB?' })
    await w.clock.advance(1100)
    expect(w.notified.length).toBe(1)
  })

  test('a session that is not the leader toasts but stays quiet', async ($, on) => {
    const w = world(on)
    w.put({ ...newAgent('older', T - 60_000), name: 'older', heartbeat: T })
    await boot($)
    w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Which DB?' })
    await w.clock.advance(1100)
    expect([w.notified.length, w.sound.chimes]).toEqual([0, 0])
    expect(w.toasts.some(t => t.includes('web needs you'))).toBe(true)
  })

  test('/office alerts off silences everything; sound off keeps notifications', async ($, on) => {
    const w = world(on)
    await boot($)
    await $.command.run({ command: 'office', args: 'alerts off' } as never)
    w.put({ ...newAgent('web', T + 50), name: 'web', state: 'needs-you', bubble: 'Which DB?' })
    await w.clock.advance(1100)
    expect([w.notified.length, w.sound.chimes, w.toasts.filter(t => t.includes('needs you')).length]).toEqual([0, 0, 0])
    await $.command.run({ command: 'office', args: 'alerts on' } as never)
    await $.command.run({ command: 'office', args: 'sound off' } as never)
    w.put({ ...newAgent('api', T + 60), name: 'api', state: 'needs-you', bubble: 'Allow Edit?' })
    await w.clock.advance(1100)
    expect([w.notified.length, w.sound.chimes]).toEqual([1, 0])
  })

  test('the band lists who waits and opens the oldest; hidden when nobody waits', async ($, on) => {
    const w = world(on)
    await boot($)
    const empty = await $.ui.mount({ plugin: 'pixel-office', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await empty.find({ key: 'band-next' })).toBeUndefined()
    await empty.unmount()
    w.put({ ...newAgent('b', T + 90), name: 'beta', state: 'needs-you', since: T + 90, bubble: 'q' })
    w.put({ ...newAgent('a', T + 10), name: 'alpha', state: 'needs-you', since: T + 10, bubble: 'q' })
    await w.clock.advance(1100)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'pixel-office', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ type: 'Text', text: /2 waiting: alpha .* · beta/ })).toBeDefined()
      await ui.press({ key: 'band-next' })
      await ui.unmount()
    }
    expect(w.opened).toContain('pixel-office')
    const pane = await $.ui.mount({ plugin: 'pixel-office', surface: 'vscode', component: 'Pane', props: PANE_PROPS, requestId: 'pixel-office' })
    expect(await pane.find({ type: 'Text', text: /Needs you \(2\)/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /answered in alpha's own window/ })).toBeDefined()
  })
})

describe('standup', () => {
  test('a press asks every session; ours answers once from a fork', async ($, on) => {
    const w = world(on)
    await boot($)
    w.put({ ...newAgent('web', T + 50), name: 'web' })
    await w.clock.advance(1100)
    const ui = await $.ui.mount({ plugin: 'pixel-office', surface: 'vscode', component: 'Pane', props: PANE_PROPS, requestId: 'pixel-office' })
    await ui.press({ key: 'standup' })
    await w.clock.advance(1100)
    const reqs = [...w.files.keys()].filter(k => /\/standup\/[^/]+\.json$/.test(k))
    expect(reqs.length).toBe(1)
    const id = reqs[0]!.split('/').at(-1)!.slice(0, -5)
    const mineFile = `${ROOT}/standup/${id}/${ME}.json`
    expect(JSON.parse(w.files.get(mineFile)!)).toMatchObject({ id: ME, done: 'fixed login', next: 'add tests', blocked: '' })
    // another session answers too
    w.files.set(`${ROOT}/standup/${id}/web.json`, JSON.stringify({ v: 1, id: 'web', name: 'web', character: 'dev-2', done: 'built the page', next: '', blocked: 'need the API key', at: w.clock.now() }))
    await w.clock.advance(3000)
    expect(w.forks.length).toBe(1)
    expect(await ui.find({ type: 'Text', text: /✓ fixed login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /❗ need the API key/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fresh session reports that it just arrived; old standups are not answered', async ($, on) => {
    const w = world(on)
    w.fork.reply = null
    await boot($)
    await $.command.run({ command: 'office', args: 'standup' } as never)
    await w.clock.advance(1100)
    const answer = [...w.files.entries()].find(([k]) => k.endsWith(`/${ME}.json`) && k.includes('/standup/'))
    expect(JSON.parse(answer![1]).done).toBe('Just got here, no work yet.')
    // a request older than the answer window is shown, never answered
    const old = messageId(w.clock.now() - 6 * 60_000, 0.4)
    w.files.set(`${ROOT}/standup/${old}.json`, JSON.stringify({ v: 1, id: old, by: 'x', requestedAt: w.clock.now() - 6 * 60_000 }))
    const before = w.forks.length
    await w.clock.advance(1100)
    expect(w.forks.length).toBe(before)
  })
})

describe('rooms and new agents', () => {
  test('a spawn ticket for this room names the session and starts its task, once', async ($, on) => {
    const w = world(on)
    const id = messageId(T - 1000, 0.7)
    const ticket = { v: 1, id, room: '/work/api-server', name: 'tests-bot', task: 'write tests for auth', character: 'dev-6', createdAt: T - 1000 }
    w.files.set(`${ROOT}/spawn/${id}.json`, JSON.stringify(ticket))
    await boot($)
    expect(w.mine()).toMatchObject({ name: 'tests-bot', character: 'dev-6', room: '/work/api-server', roomName: 'api-server' })
    await w.clock.settle()
    expect(w.prompts).toContain('write tests for auth')
    expect(w.files.has(`${ROOT}/spawn/${id}.json`)).toBe(false)
    expect(w.files.has(`${ROOT}/spawn/${id}.json.claimed`)).toBe(true)
  })

  test('a ticket for another room, or a stale one, is left alone', async ($, on) => {
    const w = world(on)
    const a = messageId(T, 0.1)
    const b = messageId(T - 4 * 60_000, 0.2)
    w.files.set(`${ROOT}/spawn/${a}.json`, JSON.stringify({ v: 1, id: a, room: '/work/other', name: 'x', task: 't', character: 'dev-1', createdAt: T }))
    w.files.set(`${ROOT}/spawn/${b}.json`, JSON.stringify({ v: 1, id: b, room: '/work/api-server', name: 'y', task: 't', character: 'dev-1', createdAt: T - 4 * 60_000 }))
    await boot($)
    expect(w.mine().name).toBe('api-server')
    expect(w.prompts.length).toBe(0)
  })

  test('a second session in the same repo gets a distinct name', async ($, on) => {
    const w = world(on)
    w.put({ ...newAgent('twin', T), name: 'api-server', cwd: '/work/api-server', room: '/work/api-server' })
    await boot($)
    expect(w.mine().name).toBe('api-server 2')
  })

  test('a standup for another room is not answered', async ($, on) => {
    const w = world(on)
    await boot($)
    const id = messageId(T, 0.9)
    w.files.set(`${ROOT}/standup/${id}.json`, JSON.stringify({ v: 1, id, by: 'x', requestedAt: T, room: '/work/docs' }))
    await w.clock.advance(1100)
    expect(w.forks.length).toBe(0)
  })

  test('a resumed session answers a standup from its history', async ($, on) => {
    const w = world(on)
    w.fork.reply = null
    w.history.push({ role: 'user', text: 'build rooms', toolUses: [] }, { role: 'assistant', text: 'Rooms are in.', toolUses: [{ tool: 'Edit' }] })
    await boot($)
    await $.command.run({ command: 'office', args: 'standup' } as never)
    await w.clock.advance(1100)
    expect(w.completions.length).toBe(1)
    expect(w.completions[0]).toContain('assistant: Rooms are in. [tools: Edit]')
    const answer = [...w.files.entries()].find(([k]) => k.endsWith(`/${ME}.json`) && k.includes('/standup/'))
    expect(JSON.parse(answer![1])).toMatchObject({ done: 'shipped the rooms', next: 'polish', blocked: '' })
  })
})

describe('lifecycle and housekeeping', () => {
  test('/clear rejoins under the new id instead of leaving', async ($, on) => {
    const w = world(on)
    await boot($)
    await $.command.run({ command: 'office', args: 'name Ada' } as never)
    w.knobs.id = 'after-clear'
    await $.session.end({ reason: 'clear', sessionId: ME } as never)
    await w.clock.advance(600)
    const fresh = JSON.parse(w.files.get(`${ROOT}/agents/after-clear.json`) ?? 'null')
    expect(fresh).toMatchObject({ id: 'after-clear', name: 'Ada' })
    expect(w.files.has(MY_FILE)).toBe(false)
  })

  test('a message delivered once is never delivered again, even if its delete failed', async ($, on) => {
    const w = world(on)
    w.knobs.rmFails = true
    await boot($)
    const m = makeMessage('you', 'you', 'once only', T, 0.5)!
    w.files.set(`${ROOT}/inbox/${ME}/${m.id}.json`, JSON.stringify(m))
    await w.clock.advance(1100)
    await w.clock.advance(1100)
    await w.clock.advance(1100)
    expect(w.prompts.filter(p => p.endsWith('once only')).length).toBe(1)
  })

  test('housekeeping removes dead sessions\' inboxes and store keys', async ($, on) => {
    const w = world(on, { store: { 'delivered:ghost': ['x'], 'standup:ghost': 'y', [`delivered:${ME}`]: ['z'] } })
    await boot($)
    w.files.set(`${ROOT}/inbox/ghost/0001759400000000-abcdef.json`, '{}')
    for (let i = 0; i < 61; i++) await w.clock.advance(1000)
    expect(w.knobs.runs.some(r => r[0] === 'rm' && r.some(a => a.endsWith('/inbox/ghost')))).toBe(true)
    expect([w.store.has('delivered:ghost'), w.store.has('standup:ghost')]).toEqual([false, false])
    expect(w.store.get(`delivered:${ME}`)).toEqual(['z'])
  })
})
