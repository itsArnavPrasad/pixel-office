import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRecord, LogLine } from '../types'
import { byUrgency, newAgent, PRUNE_MS, reduce, type Signal } from './core/agent'
import { toRasterCells, toSvg } from './core/encode'
import { asPrompt, makeMessage, parseMessage, pendingFiles } from './core/inbox'
import { assignDesks, hash, mergeRoster, parseRecord, type Seat } from './core/roster'
import { drawOffice, layout } from './core/scene'
import { LOOK_IDS } from './core/sprites'
import { basename, bubble, clean, truncate } from './core/text'

type $ = EngineInterface

const PANE = 'pixel-office'
const me = atom({ plugin: 'pixel-office', key: 'me' } as const, null)
const roster = atom({ plugin: 'pixel-office', key: 'roster' } as const, [])
const selected = atom({ plugin: 'pixel-office', key: 'selected' } as const, null)
const draft = atom({ plugin: 'pixel-office', key: 'draft' } as const, '')
const logs = atom({ plugin: 'pixel-office', key: 'logs' } as const, {})

const HEARTBEAT_MS = 2000
const POLL_MS = 1000
const FRAME_MS = 125
const SVG_FRAME_MS = 400
const LOG_KEEP = 30
const MAX_AGENTS = 64

const ICON: Record<AgentRecord['state'], string> = {
  arriving: '🚶', idle: '○', thinking: '💭', typing: '⌨', reading: '📖', writing: '✎', browsing: '🌐',
  delegating: '👥', working: '●', 'needs-you': '❗', stressed: '💦', done: '✓', leaving: '👋',
}

export const register: Register = on => {
  // Module variables: rebuilt on every (re)load, which also drops old timers.
  let root = ''
  let myId = ''
  let lastStatus = ''
  let lastWritten = ''
  let mounted: { w: number; h: number; n: number } | null = null
  let blitting: { cancel: () => void } | null = null
  let svgTicking: { cancel: () => void } | null = null
  let delivering = false

  const agentsDir = () => `${root}/agents`
  const inboxDir = (id: string) => `${root}/inbox/${id}`

  async function log($: $, id: string, who: string, text: string) {
    const line: LogLine = { at: await $.clock.now(), who, text: truncate(clean(text), 500) }
    if (!line.text) return
    await update($, logs, all => {
      const list = all[id] ?? []
      if (list.at(-1)?.text === line.text && list.at(-1)?.who === who) return all
      return { ...all, [id]: [...list, line].slice(-LOG_KEEP) }
    })
  }

  async function signal($: $, s: Signal) {
    if (!myId) return
    const now = await $.clock.now()
    const next = await update($, me, a => reduce(a ?? newAgent(myId, now), s, now))
    await save($, next)
  }

  async function save($: $, rec: AgentRecord | null) {
    if (!rec || !root) return
    const body = JSON.stringify(rec)
    if (body === lastWritten) return
    lastWritten = body
    await $.fs.write(`${agentsDir()}/${rec.id}.json`, body).catch(err => $.ui.log(`pixel-office: write failed: ${err}`))
  }

  async function poll($: $) {
    const now = await $.clock.now()
    const entries = await $.fs.list(agentsDir()).catch(() => [])
    const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json') && f.name !== `${myId}.json`).slice(0, MAX_AGENTS)
    const others: AgentRecord[] = []
    const stale: string[] = []
    for (const f of files) {
      if (now - f.mtimeMs > PRUNE_MS) {
        stale.push(`${agentsDir()}/${f.name}`)
        continue
      }
      const rec = parseRecord(await $.fs.read(`${agentsDir()}/${f.name}`).catch(() => ''))
      if (rec && rec.id === f.name.slice(0, -5)) others.push(rec)
    }
    if (stale.length) void $.process.run(['rm', '-f', '--', ...stale]).catch(() => {})

    const before = new Map((await read($, roster)).map(r => [r.id, r]))
    for (const r of others) {
      const old = before.get(r.id)
      if (r.lastLine && r.lastLine !== old?.lastLine) await log($, r.id, r.name, r.lastLine)
      else if (r.bubble && r.bubble !== old?.bubble && r.state !== 'idle') await log($, r.id, r.name, `${ICON[r.state]} ${r.bubble}`)
    }
    const changed = others.length !== before.size || others.some(r => JSON.stringify(r) !== JSON.stringify(before.get(r.id)))
    if (changed) await update($, roster, () => others)

    const seats = mergeRoster(others, await read($, me), now)
    const waiting = seats.filter(s => s.state === 'needs-you' && !s.isMe).length
    const status = seats.length > 1 ? `🏢 ${seats.length} in the office${waiting ? ` · ❗ ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}` : ''
    if (status !== lastStatus) $.ui.status((lastStatus = status) || undefined)

    await deliver($)
  }

  /** Messages addressed to this session, oldest first, each delivered once. */
  async function deliver($: $) {
    if (delivering) return
    delivering = true
    try {
      const dir = inboxDir(myId)
      const names = (await $.fs.list(dir).catch(() => [])).map(f => f.name)
      if (!names.length) return
      const cursor = String((await $.store.get(`cursor:${myId}`)) ?? '')
      for (const name of pendingFiles(names, cursor)) {
        const m = parseMessage(await $.fs.read(`${dir}/${name}`).catch(() => ''))
        await $.store.set(`cursor:${myId}`, name.slice(0, -5))
        void $.process.run(['rm', '-f', '--', `${dir}/${name}`]).catch(() => {})
        if (!m) {
          $.ui.log(`pixel-office: skipped a malformed message ${name}`)
          continue
        }
        await log($, myId, m.from === 'you' ? 'you' : m.fromName, m.text)
        $.ui.toast(`📨 Message for this session${m.from === 'you' ? '' : ` from ${m.fromName}`}`)
        void $.prompt.submit({ text: asPrompt(m) })
      }
    } finally {
      delivering = false
    }
  }

  async function send($: $, to: string, text: string) {
    const now = await $.clock.now()
    const m = makeMessage('you', 'you', text, now, Math.random())
    if (!m) return
    await log($, to, 'you', m.text)
    if (to === myId) {
      void $.prompt.submit({ text: m.text })
      return
    }
    await $.fs.write(`${inboxDir(to)}/${m.id}.json`, JSON.stringify(m))
    $.ui.toast('📨 Sent')
  }

  async function seatsNow($: $): Promise<{ seats: Seat[]; now: number }> {
    const now = await $.clock.now()
    return { seats: mergeRoster(await read($, roster), await read($, me), now), now }
  }

  function scene(seats: Seat[], columns: number, now: number) {
    const L = layout(columns, seats.length)
    const desk = assignDesks(seats.map(s => s.id), L.desks.length)
    return { L, f: drawOffice(L, seats, desk, now) }
  }

  function startBlitting($: $) {
    if (blitting) return
    blitting = $.clock.every(FRAME_MS, async () => {
      if (!mounted) return
      const { seats, now } = await seatsNow($)
      const { L, f } = scene(seats, mounted.w, now)
      // a change of desk rows needs a new mount: re-render instead of blitting
      if (L.h !== mounted.h || seats.length !== mounted.n) return $.ui.invalidate('ui.render')
      const res = await $.ui.blit({ requestId: PANE, key: 'office', cells: toRasterCells(f) })
      if ('deny' in res && res.deny) stopAnimating()
    })
  }

  function startSvgTicking($: $) {
    svgTicking ??= $.clock.every(SVG_FRAME_MS, () => $.ui.invalidate('ui.render'))
  }

  function stopAnimating() {
    blitting?.cancel()
    svgTicking?.cancel()
    blitting = svgTicking = null
    mounted = null
  }

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    try {
      root = `${(await $.env.get('HOME')) ?? '~'}/.claude/pixel-office`
      myId = await $.session.id()
      const cwd = e.cwd
      const name = String((await $.store.get(`name:${cwd}`)) ?? basename(cwd) ?? 'claude')
      const character = String((await $.store.get(`look:${cwd}`)) ?? LOOK_IDS[hash(cwd) % LOOK_IDS.length])
      await signal($, { kind: 'start', name: truncate(name, 40), cwd, character })
      await $.command.register({ name: 'office', description: 'Open the Pixel Office: every Claude session as a character you can talk to' })
      $.clock.every(HEARTBEAT_MS, () => signal($, { kind: 'tick' }))
      $.clock.every(POLL_MS, () => poll($))
    } catch (err) {
      $.ui.log(`pixel-office: could not start: ${err}`)
    }
    return ran
  })

  on('session.end', async ($, e, next) => {
    await signal($, { kind: 'end' }).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const cwd = (await read($, me))?.cwd ?? ''
    if (verb === 'name' && arg) {
      await $.store.set(`name:${cwd}`, truncate(arg, 40))
      await update($, me, a => (a ? { ...a, name: truncate(arg, 40) } : a))
      await save($, await read($, me))
      return { text: `You are now "${arg}" in the office.` }
    }
    if (verb === 'look') {
      const look = LOOK_IDS.includes(arg) ? arg : LOOK_IDS[(LOOK_IDS.indexOf((await read($, me))?.character ?? '') + 1) % LOOK_IDS.length]!
      await $.store.set(`look:${cwd}`, look)
      await update($, me, a => (a ? { ...a, character: look } : a))
      await save($, await read($, me))
      return { text: `New look: ${look}. (Looks: ${LOOK_IDS.join(', ')})` }
    }
    await $.ui.open({ id: PANE, title: 'Pixel Office' })
    return { text: 'Pixel Office is open. Tip: /office name <name>, /office look [dev-1…dev-8].' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) stopAnimating()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await signal($, { kind: 'prompt', text: e.text }).catch(() => {})
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    await signal($, { kind: 'tool', tool: String(e.tool), input: e as unknown as Record<string, unknown> }).catch(() => {})
    const ran = await next(e)
    await signal($, { kind: 'tool-done', isError: ran.isError === true }).catch(() => {})
    return ran
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const input = (e.tool_input ?? {}) as Record<string, unknown>
    const detail = typeof input.command === 'string' ? `: ${input.command}` : typeof input.file_path === 'string' ? `: ${basename(input.file_path)}` : ''
    await signal($, { kind: 'needs-you', text: bubble(`Allow ${e.tool_name}${detail}?`) }).catch(() => {})
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/i.test(e.notification_type)) await signal($, { kind: 'needs-you', text: e.message }).catch(() => {})
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await signal($, { kind: 'interns', delta: 1 }).catch(() => {})
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await signal($, { kind: 'interns', delta: -1 }).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await signal($, { kind: 'turn-done', text: e.answer }).catch(() => {})
      if (e.answer) await log($, myId, (await read($, me))?.name ?? 'claude', e.answer).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const { seats, now } = await seatsNow($)
    const columns = Math.max(24, e.props.bodyColumns)
    const pick = await read($, selected)
    const chosen = seats.find(s => s.id === pick) ?? null

    let office
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e as typeof e & { surface: 'terminal' })
      const { L, f } = scene(seats, columns, now)
      mounted = { w: L.w, h: L.h, n: seats.length }
      startBlitting($)
      office = <Raster key="office" columns={L.w} rows={L.h / 2} cells={toRasterCells(f)} />
    } else {
      const { Svg } = $.ui.resolve(e as typeof e & { surface: 'desktop' })
      const { L, f } = scene(seats, Math.min(columns, 132), now)
      startSvgTicking($)
      office = <Svg source={toSvg(f, 6)} alt={`Pixel office with ${seats.length} agents`} width={L.w * 6} />
    }

    const chips = [...seats].sort(byUrgency).slice(0, 9)
    return (
      <Box flexDirection="column">
        {office}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {chips.map((s, i) => (
            <Button
              key={`chip-${s.id}`}
              hotkey={String(i + 1)}
              variant={s.state === 'needs-you' ? 'primary' : undefined}
              label={`${ICON[s.state]} ${truncate(s.name, 16)}${s.isMe ? ' (here)' : ''}${s.isAway ? ' · away' : ''}`}
              onPress={() => update($, selected, cur => (cur === s.id ? null : s.id))}
            />
          ))}
        </Box>
        {seats.length < 2 && <Text dimColor>Start another Claude Code session: it walks in and takes a desk.</Text>}
        {chosen && (await dialogue($, chosen, { Box, Text, Button, Input }))}
      </Box>
    )
  })

  async function dialogue($: $, s: Seat, el: Pick<ReturnType<$['ui']['resolve']>, 'Box' | 'Text' | 'Button'> & { Input?: unknown }) {
    const { Box, Text, Button } = el
    const Input = el.Input as ReturnType<$['ui']['resolve']>['Box'] | undefined
    const lines = ((await read($, logs))[s.id] ?? []).slice(-8)
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>
          {ICON[s.state]} {s.name} <Text dimColor>· {s.state}{s.isAway ? ' · away' : ''} · {s.turns} turns · {s.tools} tools · {basename(s.cwd)}</Text>
        </Text>
        {s.bubble ? <Text>“{s.bubble}”</Text> : null}
        {lines.map(l => (
          <Text dimColor={l.who !== 'you'}>
            <Text bold>{l.who === 'you' ? 'you' : l.who}:</Text> {truncate(l.text, 300)}
          </Text>
        ))}
        {Input ? (
          <Input
            key="reply"
            placeholder={s.isMe ? 'Prompt this session…' : `Message ${s.name}…`}
            submitLabel="Send"
            autoFocus
            onSubmit={(text: string) => send($, s.id, text)}
          />
        ) : (
          <Text dimColor>Replying needs a surface with text input.</Text>
        )}
        <Button key="close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
      </Box>
    )
  }
}
