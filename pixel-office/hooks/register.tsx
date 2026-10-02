import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderPropsOf } from 'claude-code'

import type { AgentRecord, LogLine, Standup, StandupAnswer } from '../types'
import { byUrgency, newAgent, PRUNE_MS, reduce, type Signal } from './core/agent'
import { alertLeader, alertsDue, formatWait, notifyArgv, waitingQueue } from './core/alerts'
import { toRasterCells, toSvg } from './core/encode'
import { asPrompt, makeMessage, messageId, parseMessage, pendingFiles } from './core/inbox'
import { assignDesks, hash, mergeRoster, parseRecord, type Seat } from './core/roster'
import { drawOffice, layout, type Spotlight } from './core/scene'
import { LOOK_IDS } from './core/sprites'
import {
  ANSWER_WINDOW_MS, KEEP_MS, PENDING_MS, SHOW_MS, STANDUP_PROMPT, headline, latestRequest, makeRequest, parseAnswer,
  parseReport, parseRequest, presenter,
} from './core/standup'
import { basename, bubble, clean, truncate } from './core/text'

type $ = EngineInterface

const PANE = 'pixel-office'
const me = atom({ plugin: 'pixel-office', key: 'me' } as const, null)
const roster = atom({ plugin: 'pixel-office', key: 'roster' } as const, [])
const selected = atom({ plugin: 'pixel-office', key: 'selected' } as const, null)
const logs = atom({ plugin: 'pixel-office', key: 'logs' } as const, {})
const alerted = atom({ plugin: 'pixel-office', key: 'alerted' } as const, {})
const standup = atom({ plugin: 'pixel-office', key: 'standup' } as const, null)

const HEARTBEAT_MS = 2000
const POLL_MS = 1000
const FRAME_MS = 125
const SVG_FRAME_MS = 400
const LOG_KEEP = 30
const MAX_AGENTS = 64
const GC_EVERY = 60 // polls
const CHIME = 'sounds/chime.wav'
const UI_FRESH_MS = 10_000 // an editor window heartbeating this recently does the chime + notification

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
  isAnswering: false,
  isAlertsOn: true,
  isSoundOn: true,
  polls: 0,
}

const agentsDir = () => `${rt.root}/agents`
const inboxDir = (id: string) => `${rt.root}/inbox/${id}`
const standupDir = () => `${rt.root}/standup`
const uiDir = () => `${rt.root}/ui`

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

  await alert($, seats, now)
  await deliver($)
  await pollStandup($, now)
  if (++rt.polls % GC_EVERY === 0) await sweepStandups($, now)
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

/** Toasts in every session; chime and OS notification from the alert leader only. */
async function alert($: $, seats: Seat[], now: number) {
  const due = alertsDue(waitingQueue(seats), await read($, alerted), now)
  if (JSON.stringify(due.memory) !== JSON.stringify(await read($, alerted))) await update($, alerted, () => due.memory)
  if (!rt.isAlertsOn || (!due.fresh.length && !due.remind.length)) return
  const isLeader = alertLeader(seats) === rt.myId && !(await isEditorWatching($, now))
  for (const s of due.fresh) {
    if (!s.isMe) $.ui.toast(`❗ ${s.name} needs you: ${s.bubble}`)
    if (isLeader) void $.process.run(notifyArgv(`❗ ${s.name} needs you`, s.bubble || 'Waiting for you')).catch(() => {})
  }
  for (const s of due.remind) {
    const waited = formatWait(now - s.since)
    if (!s.isMe) $.ui.toast(`❗ ${s.name} is still waiting (${waited})`)
    if (isLeader) void $.process.run(notifyArgv(`❗ ${s.name} still waiting · ${waited}`, s.bubble || 'Waiting for you')).catch(() => {})
  }
  if (isLeader && rt.isSoundOn) void $.audio.play({ asset: CHIME }).catch(() => {})
}

/** Whether a Pixel Office editor window is open (it announces itself in ui/). */
async function isEditorWatching($: $, now: number): Promise<boolean> {
  const peers = await $.fs.list(uiDir()).catch(() => [])
  return peers.some(f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < UI_FRESH_MS)
}

async function openOn($: $, id: string) {
  await update($, selected, () => id)
  await $.ui.open({ id: PANE, title: 'Pixel Office' })
}

async function requestStandup($: $) {
  const now = await $.clock.now()
  const id = messageId(now, Math.random())
  const by = (await read($, me))?.name ?? 'someone'
  await $.fs.write(`${standupDir()}/${id}.json`, JSON.stringify(makeRequest(id, by, now)))
  $.ui.toast('🗣 Standup! Everyone is reporting in…')
  await pollStandup($, now)
}

/** Loads the latest standup into state, and answers it once if it is fresh. */
async function pollStandup($: $, now: number) {
  const names = (await $.fs.list(standupDir()).catch(() => [])).map(f => f.name)
  const id = latestRequest(names, now, SHOW_MS)
  const shown = await read($, standup)
  if (!id) {
    if (shown) await update($, standup, () => null)
    return
  }
  const request = parseRequest(await $.fs.read(`${standupDir()}/${id}.json`).catch(() => ''))
  if (!request) return
  const answers: StandupAnswer[] = []
  for (const f of await $.fs.list(`${standupDir()}/${id}`).catch(() => [])) {
    const a = parseAnswer(await $.fs.read(`${standupDir()}/${id}/${f.name}`).catch(() => ''))
    if (a && `${a.id}.json` === f.name) answers.push(a)
  }
  const next = { request, answers: answers.sort((a, b) => a.at - b.at) }
  if (JSON.stringify(next) !== JSON.stringify(shown)) await update($, standup, () => next)

  const key = `standup:${rt.myId}`
  if (rt.isAnswering || now - request.requestedAt > ANSWER_WINDOW_MS || (await $.store.get(key)) === id) return
  await $.store.set(key, id) // claimed before the fork, so a slow fork is never asked twice
  rt.isAnswering = true
  void answerStandup($, id).finally(() => (rt.isAnswering = false))
}

async function answerStandup($: $, requestId: string) {
  const r = await $.model.fork({ prompt: STANDUP_PROMPT }).catch(() => null)
  const report =
    r && r.isAnswered ? parseReport(r.text)
    : r && r.reason === 'nothing-to-fork' ? { done: 'Just got here, no work yet.', next: '', blocked: '' }
    : { done: "(couldn't report)", next: '', blocked: '' }
  const self = await read($, me)
  const answer: StandupAnswer = {
    v: 1, id: rt.myId, name: self?.name ?? 'claude', character: self?.character ?? 'dev-1', ...report, at: await $.clock.now(),
  }
  await $.fs.write(`${standupDir()}/${requestId}/${rt.myId}.json`, JSON.stringify(answer))
}

/** Removes standups older than KEEP_MS; only names that parse as request ids. */
async function sweepStandups($: $, now: number) {
  const old = (await $.fs.list(standupDir()).catch(() => []))
    .map(f => f.name.replace(/\.json$/, ''))
    .filter(id => /^\d{13}-[0-9a-z]{6}$/.test(id) && now - Number(id.slice(0, 13)) > KEEP_MS)
  const paths = [...new Set(old)].flatMap(id => [`${standupDir()}/${id}`, `${standupDir()}/${id}.json`])
  if (paths.length) void $.process.run(['rm', '-rf', '--', ...paths]).catch(() => {})
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

function scene(seats: Seat[], columns: number, now: number, spot: Spotlight | null = null) {
  const L = layout(columns, seats.length)
  const desk = assignDesks(seats.map(s => s.id), L.desks.length)
  return { L, f: drawOffice(L, seats, desk, now, undefined, spot) }
}

async function spotlightNow($: $, seats: Seat[], now: number): Promise<Spotlight | null> {
  const st = await read($, standup)
  if (!st) return null
  const here = st.answers.filter(a => seats.some(s => s.id === a.id))
  const id = presenter(here, st.request.requestedAt, now)
  const a = here.find(x => x.id === id)
  return a ? { id: a.id, text: headline(a), isBlocked: !!a.blocked } : null
}

function startBlitting($: $) {
  rt.blitting ??= $.clock.every(FRAME_MS, () => blitFrame($))
}

async function blitFrame($: $) {
  const m = rt.mounted
  if (!m) return
  const { seats, now } = await seatsNow($)
  const { L, f } = scene(seats, m.w, now, await spotlightNow($, seats, now))
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
  rt.isAlertsOn = (await $.store.get('alerts')) !== 'off'
  rt.isSoundOn = (await $.store.get('sound')) !== 'off'
  const name = String((await $.store.get(`name:${cwd}`)) ?? (basename(cwd) || 'claude'))
  const character = String((await $.store.get(`look:${cwd}`)) ?? LOOK_IDS[hash(cwd) % LOOK_IDS.length])
  // $PPID of a child shell is this Claude process: what an editor matches its terminals against
  const ran = await $.process.run(['sh', '-c', 'echo $PPID']).catch(() => null)
  const pid = Number.parseInt(ran?.stdout.trim() ?? '', 10)
  await signal($, { kind: 'start', name: truncate(name, 40), cwd, character, pid: Number.isFinite(pid) ? pid : 0 })
  await $.command.register({ name: 'office', description: 'Open the Pixel Office: every Claude session as a character you can talk to' })
  $.clock.every(HEARTBEAT_MS, () => signal($, { kind: 'tick' }))
  $.clock.every(POLL_MS, () => poll($))
}

async function office($: $, e: { surface: string; props: RenderPropsOf['Pane'] }) {
  const { seats, now } = await seatsNow($)
  const columns = Math.max(24, e.props.bodyColumns)
  const spot = await spotlightNow($, seats, now)
  if (e.surface === 'terminal') {
    const { L, f } = scene(seats, columns, now, spot)
    rt.mounted = { w: L.w, h: L.h, n: seats.length }
    startBlitting($)
    return { kind: 'raster' as const, columns: L.w, rows: L.h / 2, cells: toRasterCells(f), seats }
  }
  const { L, f } = scene(seats, Math.min(columns, 132), now, spot)
  startSvgTicking($)
  return { kind: 'svg' as const, source: toSvg(f, 6), width: L.w * 6, seats }
}

function standupCard($: $, e: Parameters<$['ui']['resolve']>[0], st: Standup, seats: Seat[], now: number) {
  const { Box, Text } = $.ui.resolve(e)
  const rows = new Map<string, { name: string; a?: StandupAnswer }>()
  for (const s of seats) rows.set(s.id, { name: s.name })
  for (const a of st.answers) rows.set(a.id, { name: a.name, a })
  const isLate = now - st.request.requestedAt > PENDING_MS
  return (
    <Box key="standup-card" flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        🗣 Standup <Text dimColor>· called by {st.request.by} {formatWait(now - st.request.requestedAt)} ago</Text>
      </Text>
      {[...rows.values()].map(({ name, a }) =>
        a ? (
          <Box flexDirection="column">
            <Text bold>{truncate(name, 24)}</Text>
            {a.done ? <Text>  ✓ {a.done}</Text> : null}
            {a.next ? <Text dimColor>  → {a.next}</Text> : null}
            {a.blocked ? <Text color="yellow">  ❗ {a.blocked}</Text> : null}
          </Box>
        ) : (
          <Text dimColor>{truncate(name, 24)} {isLate ? '(no answer)' : '… thinking'}</Text>
        ),
      )}
    </Box>
  )
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
    if (verb === 'standup') {
      await requestStandup($)
      await $.ui.open({ id: PANE, title: 'Pixel Office' })
      return { text: 'Standup called: every session is reporting in.' }
    }
    if ((verb === 'alerts' || verb === 'sound') && (arg === 'on' || arg === 'off')) {
      await $.store.set(verb, arg)
      if (verb === 'alerts') rt.isAlertsOn = arg === 'on'
      else rt.isSoundOn = arg === 'on'
      return { text: `${verb === 'alerts' ? 'Alerts' : 'Chime'} ${arg}.` }
    }
    if (verb === 'look') {
      const cur = (await read($, me))?.character ?? ''
      const look = LOOK_IDS.includes(arg) ? arg : LOOK_IDS[(LOOK_IDS.indexOf(cur) + 1) % LOOK_IDS.length]!
      await setIdentity($, 'character', look)
      return { text: `New look: ${look}. Looks: ${LOOK_IDS.join(', ')}.` }
    }
    await $.ui.open({ id: PANE, title: 'Pixel Office' })
    return { text: 'Pixel Office is open. Tip: /office standup · /office name <name> · /office look · /office alerts|sound on|off' }
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

    const now = await $.clock.now()
    const queue = waitingQueue(view.seats).filter(s => !s.isMe)
    const st = await read($, standup)
    const chips = [...view.seats].sort(byUrgency).slice(0, 9)
    return (
      <Box flexDirection="column">
        {queue.length > 0 && (
          <Box key="queue" flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold color="yellow">❗ Needs you ({queue.length})</Text>
            {queue.slice(0, 5).map(s => (
              <Text>
                <Text bold>{truncate(s.name, 20)}</Text> <Text dimColor>· waiting {formatWait(now - s.since)} ·</Text> {truncate(s.bubble, 70)}
              </Text>
            ))}
          </Box>
        )}
        {scene}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {queue[0] && <Button key="next" hotkey="n" variant="primary" label={`❗ Next: ${truncate(queue[0].name, 14)}`} onPress={() => openOn($, queue[0]!.id)} />}
          <Button key="standup" hotkey="s" label="🗣 Standup" onPress={() => requestStandup($)} />
        </Box>
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
        {st && standupCard($, e, st, view.seats, now)}
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>
              {ICON[chosen.state]} {chosen.name}{' '}
              <Text dimColor>
                · {chosen.state}{chosen.isAway ? ' · away' : ''} · {chosen.turns} turns · {chosen.tools} tools · {basename(chosen.cwd)}
              </Text>
            </Text>
            {chosen.bubble ? <Text>“{chosen.bubble}”</Text> : null}
            {chosen.state === 'needs-you' && !chosen.isMe && (
              <Text color="yellow">Permission prompts are answered in {chosen.name}'s own window. A message sent here runs after it.</Text>
            )}
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !rt.myId) return next(e)
    const { seats, now } = await seatsNow($)
    const queue = waitingQueue(seats).filter(s => !s.isMe)
    if (!queue.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = queue.slice(0, 3).map(s => `${truncate(s.name, 16)} ${formatWait(now - s.since)}`).join(' · ')
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="yellow" wrap="truncate-end">
          ❗ {queue.length} waiting: {list}{queue.length > 3 ? ' …' : ''}
        </Text>
        <Button key="band-next" hotkey="n" variant="primary" label={`Open ${truncate(queue[0]!.name, 14)}`} onPress={() => openOn($, queue[0]!.id)} />
      </Box>
    )
  })
}
