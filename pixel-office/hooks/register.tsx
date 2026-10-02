import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderPropsOf } from 'claude-code'

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

// Module state: rebuilt on every (re)load, which also drops the old timers.
const rt = {
  root: '',
  myId: '',
  lastStatus: '',
  lastWritten: '',
  mounted: null as { w: number; h: number; n: number } | null,
  blitting: null as { cancel: () => void } | null,
  svgTicking: null as { cancel: () => void } | null,
  isDelivering: false,
}

const agentsDir = () => `${rt.root}/agents`
const inboxDir = (id: string) => `${rt.root}/inbox/${id}`

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
  if (!rt.myId) return
  const now = await $.clock.now()
  const id = rt.myId
  await update($, me, a => reduce(a ?? newAgent(id, now), s, now))
  await save($)
}

async function save($: $) {
  const rec = await read($, me)
  if (!rec || !rt.root) return
  const body = JSON.stringify(rec)
  if (body === rt.lastWritten) return
  rt.lastWritten = body
  await $.fs.write(`${agentsDir()}/${rec.id}.json`, body).catch(err => $.ui.log(`pixel-office: write failed: ${err}`))
}

async function poll($: $) {
  const now = await $.clock.now()
  const entries = await $.fs.list(agentsDir()).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json') && f.name !== `${rt.myId}.json`).slice(0, MAX_AGENTS)
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
  if (status !== rt.lastStatus) $.ui.status((rt.lastStatus = status) || undefined)

  await deliver($)
}

/** Messages addressed to this session, oldest first, each delivered once. */
async function deliver($: $) {
  if (rt.isDelivering || !rt.myId) return
  rt.isDelivering = true
  try {
    const dir = inboxDir(rt.myId)
    const names = (await $.fs.list(dir).catch(() => [])).map(f => f.name)
    if (!names.length) return
    const key = `cursor:${rt.myId}`
    const cursor = String((await $.store.get(key)) ?? '')
    for (const name of pendingFiles(names, cursor)) {
      const m = parseMessage(await $.fs.read(`${dir}/${name}`).catch(() => ''))
      await $.store.set(key, name.slice(0, -5))
      void $.process.run(['rm', '-f', '--', `${dir}/${name}`]).catch(() => {})
      if (!m) {
        $.ui.log(`pixel-office: skipped a malformed message ${name}`)
        continue
      }
      await log($, rt.myId, m.from === 'you' ? 'you' : m.fromName, m.text)
      $.ui.toast(`📨 Message for this session${m.from === 'you' ? '' : ` from ${m.fromName}`}`)
      void $.prompt.submit({ text: asPrompt(m) })
    }
  } finally {
    rt.isDelivering = false
  }
}

async function send($: $, to: string, text: string) {
  const m = makeMessage('you', 'you', text, await $.clock.now(), Math.random())
  if (!m) return
  await log($, to, 'you', m.text)
  if (to === rt.myId) {
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
  rt.blitting ??= $.clock.every(FRAME_MS, () => blitFrame($))
}

async function blitFrame($: $) {
  const m = rt.mounted
  if (!m) return
  const { seats, now } = await seatsNow($)
  const { L, f } = scene(seats, m.w, now)
  // more or fewer desk rows is a new mount: redraw instead of blitting
  if (L.h !== m.h || seats.length !== m.n) return $.ui.invalidate('ui.render')
  const res = await $.ui.blit({ requestId: PANE, key: 'office', cells: toRasterCells(f) })
  if ('deny' in res && res.deny) stopAnimating()
}

function startSvgTicking($: $) {
  rt.svgTicking ??= $.clock.every(SVG_FRAME_MS, () => $.ui.invalidate('ui.render'))
}

function stopAnimating() {
  rt.blitting?.cancel()
  rt.svgTicking?.cancel()
  rt.blitting = rt.svgTicking = null
  rt.mounted = null
}

async function setIdentity($: $, field: 'name' | 'character', value: string) {
  const cwd = (await read($, me))?.cwd ?? ''
  await $.store.set(`${field === 'name' ? 'name' : 'look'}:${cwd}`, value)
  await update($, me, a => (a ? { ...a, [field]: value } : a))
  await save($)
}

async function start($: $, cwd: string) {
  rt.root = `${(await $.env.get('HOME')) ?? '~'}/.claude/pixel-office`
  rt.myId = await $.session.id()
  const name = String((await $.store.get(`name:${cwd}`)) ?? (basename(cwd) || 'claude'))
  const character = String((await $.store.get(`look:${cwd}`)) ?? LOOK_IDS[hash(cwd) % LOOK_IDS.length])
  await signal($, { kind: 'start', name: truncate(name, 40), cwd, character })
  await $.command.register({ name: 'office', description: 'Open the Pixel Office: every Claude session as a character you can talk to' })
  $.clock.every(HEARTBEAT_MS, () => signal($, { kind: 'tick' }))
  $.clock.every(POLL_MS, () => poll($))
}

async function office($: $, e: { surface: string; props: RenderPropsOf['Pane'] }) {
  const { seats, now } = await seatsNow($)
  const columns = Math.max(24, e.props.bodyColumns)
  if (e.surface === 'terminal') {
    const { L, f } = scene(seats, columns, now)
    rt.mounted = { w: L.w, h: L.h, n: seats.length }
    startBlitting($)
    return { kind: 'raster' as const, columns: L.w, rows: L.h / 2, cells: toRasterCells(f), seats }
  }
  const { L, f } = scene(seats, Math.min(columns, 132), now)
  startSvgTicking($)
  return { kind: 'svg' as const, source: toSvg(f, 6), width: L.w * 6, seats }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await start($, e.cwd).catch(err => $.ui.log(`pixel-office: could not start: ${err}`))
    return ran
  })

  on('session.end', async ($, e, next) => {
    await signal($, { kind: 'end' }).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    if (verb === 'name' && arg) {
      await setIdentity($, 'name', truncate(arg, 40))
      return { text: `You are now "${truncate(arg, 40)}" in the office.` }
    }
    if (verb === 'look') {
      const cur = (await read($, me))?.character ?? ''
      const look = LOOK_IDS.includes(arg) ? arg : LOOK_IDS[(LOOK_IDS.indexOf(cur) + 1) % LOOK_IDS.length]!
      await setIdentity($, 'character', look)
      return { text: `New look: ${look}. Looks: ${LOOK_IDS.join(', ')}.` }
    }
    await $.ui.open({ id: PANE, title: 'Pixel Office' })
    return { text: 'Pixel Office is open. Tip: /office name <name> · /office look [dev-1…dev-8]' }
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
    const detail =
      typeof input.command === 'string' ? `: ${input.command}` : typeof input.file_path === 'string' ? `: ${basename(input.file_path)}` : ''
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
      if (e.answer) await log($, rt.myId, (await read($, me))?.name ?? 'claude', e.answer).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await office($, e)
    const pick = await read($, selected)
    const chosen = view.seats.find(s => s.id === pick) ?? null
    const lines = chosen ? ((await read($, logs))[chosen.id] ?? []).slice(-8) : []

    let scene
    if (view.kind === 'raster' && e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      scene = <Raster key="office" columns={view.columns} rows={view.rows} cells={view.cells} />
    } else if (view.kind === 'svg' && e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      scene = <Svg source={view.source} alt={`Pixel office with ${view.seats.length} agents`} width={view.width} />
    }

    let reply
    if (chosen && e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      reply = (
        <Input
          key="reply"
          placeholder={chosen.isMe ? 'Prompt this session…' : `Message ${chosen.name}…`}
          submitLabel="Send"
          autoFocus
          onSubmit={text => send($, chosen.id, text)}
        />
      )
    }

    const chips = [...view.seats].sort(byUrgency).slice(0, 9)
    return (
      <Box flexDirection="column">
        {scene}
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
        {view.seats.length < 2 && <Text dimColor>Start another Claude Code session: it walks in and takes a desk.</Text>}
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>
              {ICON[chosen.state]} {chosen.name}{' '}
              <Text dimColor>
                · {chosen.state}{chosen.isAway ? ' · away' : ''} · {chosen.turns} turns · {chosen.tools} tools · {basename(chosen.cwd)}
              </Text>
            </Text>
            {chosen.bubble ? <Text>“{chosen.bubble}”</Text> : null}
            {lines.map(l => (
              <Text dimColor={l.who !== 'you'}>
                <Text bold>{l.who}:</Text> {truncate(l.text, 300)}
              </Text>
            ))}
            {reply ?? <Text dimColor>Replying needs a surface with text input.</Text>}
            <Button key="close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
          </Box>
        )}
      </Box>
    )
  })
}
