// The office page. Rooms (one per repository) on the left, each with its own scene and roster;
// the selected agent's live console on the right. Elements are kept and updated in place, so
// canvases, open tool calls, scroll position and a half-typed reply survive every update.
import { formatWait } from '../../pixel-office/hooks/core/alerts'
import { assignDesks, type Seat } from '../../pixel-office/hooks/core/roster'
import { DEFAULT_THEME, drawOffice, hitTest, layout, type Layout, type Spotlight, type Theme } from '../../pixel-office/hooks/core/scene'
import { headline, PENDING_MS, presenter } from '../../pixel-office/hooks/core/standup'
import type { FromWebview, RoomView, ViewState } from '../src/protocol'
import { blocks, type Block, type Entry, type PlanItem } from '../src/transcript'
import { clock, esc, markdown, short, tildify } from './format'
import { cellAt, deskCentre, fit } from './geometry'

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): unknown; setState(s: unknown): void }
const vscode = acquireVsCodeApi()
const isMini = document.body.classList.contains('mode-mini')
const post = (m: FromWebview) => vscode.postMessage(m)

const ICON: Record<string, string> = {
  arriving: '🚶', idle: '○', thinking: '💭', typing: '⌨️', reading: '📖', writing: '✏️', browsing: '🌐',
  delegating: '👥', working: '●', 'needs-you': '❗', stressed: '💦', done: '✓', leaving: '👋',
}
const STATE_LABEL: Record<string, string> = { 'needs-you': 'needs you', delegating: 'with interns' }

type Saved = { collapsed: string[]; filter: 'conversation' | 'everything'; dismissed: string[] }
const stored = (vscode.getState() as Partial<Saved> | undefined) ?? {}
const saved: Saved = {
  collapsed: stored.collapsed ?? [], filter: stored.filter === 'everything' ? 'everything' : 'conversation', dismissed: stored.dismissed ?? [],
}
const save = () => vscode.setState(saved)

let v: ViewState | null = null
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T

// ── skeleton ───────────────────────────────────────────────────────
document.getElementById('app')!.innerHTML = `
  <header class="top">
    <span class="brand">🏢 Pixel Office</span><span id="summary" class="dim"></span><span class="grow"></span>
    <button id="new" title="Start a new Claude Code agent in a room">＋ New agent</button>
    <button id="standup-all" title="Every agent in every room reports Done / Next / Blocked">🗣 Standup</button>
    <button id="next" class="primary" hidden></button>
  </header>
  <div id="banner"></div>
  <div id="attention"></div>
  <div class="layout"><div id="rooms"></div><aside id="console" hidden></aside></div>`
$('#new').onclick = () => post({ type: 'newAgent', room: null })
$('#standup-all').onclick = () => post({ type: 'standup', room: null })
$('#next').onclick = () => v?.queue[0] && pick(v.queue[0])

/** In the sidebar a click opens the big panel on that agent; in the panel it opens the console. */
function pick(id: string) {
  post(isMini ? { type: 'openPanel', id } : { type: 'select', id })
}

window.addEventListener('message', e => {
  if (e.data?.type !== 'view') return
  v = e.data as ViewState
  render()
})
post({ type: 'ready' })

// ── rooms ──────────────────────────────────────────────────────────
type Stage = { el: HTMLElement; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; off: HTMLCanvasElement; offCtx: CanvasRenderingContext2D; card: HTMLElement; L: Layout; desk: Map<string, number>; scale: number; seats: Seat[] }
const stages = new Map<string, Stage>()

function roomSection(r: RoomView): HTMLElement {
  let el = document.querySelector<HTMLElement>(`section.room[data-room="${CSS.escape(r.id)}"]`)
  if (el) return el
  el = document.createElement('section')
  el.className = 'room'
  el.dataset.room = r.id
  el.innerHTML = `<div class="room-head"></div><div class="room-body"><div class="stage"><canvas></canvas><button class="fs" title="Full screen (Esc to exit)">⛶</button><div class="card" hidden></div></div>
    <div class="roster"></div><div class="room-standup"></div></div>`
  const canvas = $<HTMLCanvasElement>('canvas', el)
  const off = document.createElement('canvas')
  const stage: Stage = { el, canvas, ctx: canvas.getContext('2d')!, off, offCtx: off.getContext('2d')!, card: $('.card', el), L: layout(46, 1), desk: new Map(), scale: 2, seats: [] }
  stages.set(r.id, stage)
  canvas.onclick = e => {
    const s = seatAt(stage, e)
    if (s) pick(s.id)
  }
  canvas.onmousemove = e => hover(stage, e)
  canvas.onmouseleave = () => (stage.card.hidden = true)
  // the full-screen button shows while the pointer moves over the office, and fades once it rests
  const box = canvas.parentElement!
  let idle = 0
  box.onmousemove = () => (box.classList.add('show'), clearTimeout(idle), (idle = window.setTimeout(() => box.classList.remove('show'), 2000)))
  box.onmouseleave = () => (clearTimeout(idle), box.classList.remove('show'))
  $<HTMLButtonElement>('.fs', el).onclick = () => setFull(box, !box.classList.contains('full'))
  return el
}

/** Fills the screen with one office; falls back to filling the panel where the webview refuses real full screen. */
function setFull(box: HTMLElement, on: boolean) {
  box.classList.toggle('full', on)
  if (on) box.requestFullscreen?.().catch(() => {})
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.querySelectorAll<HTMLElement>('.stage.full').forEach(b => setFull(b, false))
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll<HTMLElement>('.stage.full').forEach(b => setFull(b, false))
})

function renderRooms(byId: Map<string, Seat>) {
  const box = $('#rooms')
  const want = v!.rooms.map(r => r.id)
  for (const [id, st] of stages) if (!want.includes(id)) (st.el.remove(), stages.delete(id))
  v!.rooms.forEach((r, i) => {
    const el = roomSection(r)
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null)
    const seats = r.seatIds.map(id => byId.get(id)).filter((s): s is Seat => !!s)
    stages.get(r.id)!.seats = seats
    const isCollapsed = saved.collapsed.includes(r.id)
    el.classList.toggle('collapsed', isCollapsed)
    el.classList.toggle('alert', r.waiting > 0)

    $('.room-head', el).innerHTML = `
      <button class="fold" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▸' : '▾'}</button>
      <span class="room-name">📁 ${esc(r.name)}</span>
      ${r.branch ? `<span class="branch" title="branch">⎇ ${esc(r.branch)}</span>` : ''}
      <span class="dim path" title="${esc(r.id)}">${esc(tildify(r.id, v!.home))}</span>
      <span class="grow"></span>
      <span class="count">${seats.length} agent${seats.length === 1 ? '' : 's'}</span>
      ${r.waiting ? `<span class="badge warn">❗ ${r.waiting} waiting</span>` : ''}
      <button class="room-standup-btn" title="Standup for this room">🗣</button>
      <button class="room-new" title="New agent in ${esc(r.name)}">＋</button>`
    $<HTMLButtonElement>('.fold', el).onclick = () => {
      saved.collapsed = isCollapsed ? saved.collapsed.filter(x => x !== r.id) : [...saved.collapsed, r.id]
      save()
      render()
    }
    $<HTMLButtonElement>('.room-standup-btn', el).onclick = () => post({ type: 'standup', room: r.id })
    $<HTMLButtonElement>('.room-new', el).onclick = () => post({ type: 'newAgent', room: r.id })

    const rows = [...seats].sort((a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you') || a.name.localeCompare(b.name))
    $('.roster', el).innerHTML = rows.map(s => {
      const ins = v!.insights[s.id] ?? {}
      const since = s.state === 'needs-you' ? `waiting ${formatWait(v!.now - s.since)}` : formatWait(v!.now - s.since)
      return `<button class="agent${s.id === v!.selected ? ' on' : ''}${s.isAway ? ' away' : ''} st-${s.state}" data-id="${esc(s.id)}">
        <span class="ic">${ICON[s.state] ?? '●'}</span>
        <span class="nm">${esc(short(s.name, 24))}</span>
        <span class="pill">${esc(STATE_LABEL[s.state] ?? s.state)}${s.isAway ? ' · away' : ''}</span>
        <span class="bb" title="${esc(s.detail || s.bubble)}">${esc(short(s.bubble, 70))}</span>
        <span class="mt">${esc([ins.changes, since].filter(Boolean).join(' · '))}</span></button>`
    }).join('')
    for (const b of el.querySelectorAll<HTMLElement>('.agent')) b.onclick = () => pick(b.dataset.id!)

    $('.room-standup', el).innerHTML = standupHtml(r, seats)
  })
  if (!v!.rooms.length) box.innerHTML = ''
}

function standupHtml(r: RoomView, seats: Seat[]): string {
  const st = v!.standup
  if (!st || (st.request.room && st.request.room !== r.id)) return ''
  const ids = new Set(seats.map(s => s.id))
  const answers = new Map(st.answers.filter(a => ids.has(a.id)).map(a => [a.id, a]))
  const late = v!.now - st.request.requestedAt > PENDING_MS
  return `<div class="card ok"><div class="card-title">🗣 Standup <span class="dim">· called by ${esc(st.request.by)} ${formatWait(v!.now - st.request.requestedAt)} ago</span></div>
    <div class="su-grid">${seats.map(s => {
      const a = answers.get(s.id)
      if (!a) return `<div class="su dim"><b>${esc(s.name)}</b> ${late ? '(no answer)' : '… thinking'}</div>`
      return `<div class="su"><b>${esc(s.name)}</b>${a.done ? `<div>✓ ${esc(a.done)}</div>` : ''}${a.next ? `<div class="dim">→ ${esc(a.next)}</div>` : ''}${a.blocked ? `<div class="warnText">❗ ${esc(a.blocked)}</div>` : ''}</div>`
    }).join('')}</div></div>`
}

// ── attention: who needs you, collisions ───────────────────────────
function renderAttention(byId: Map<string, Seat>) {
  const queue = v!.queue.map(id => byId.get(id)).filter((s): s is Seat => !!s)
  const roomOf = (s: Seat) => s.roomName || ''
  // dismissed collisions stay hidden until a new one appears; "hide forever" is a setting
  const shownCollisions = v!.showCollisions ? v!.collisions.filter(c => !saved.dismissed.includes(collisionKey(c))) : []
  $('#attention').innerHTML =
    (queue.length
      ? `<div class="card warn"><div class="card-title">❗ Needs you (${queue.length})</div>${queue.slice(0, isMini ? 3 : 6).map(s =>
          `<div class="qrow" data-id="${esc(s.id)}"><b>${esc(short(s.name, 22))}</b> <span class="dim">${esc(roomOf(s))} · waiting ${formatWait(v!.now - s.since)}</span> ${esc(short(s.bubble, 90))}</div>`).join('')}</div>`
      : '') +
    (shownCollisions.length
      ? `<div class="card danger"><div class="card-head"><span class="card-title">⚠ Collision radar</span><span class="grow"></span>
          <button class="link" id="col-dismiss" title="Hide these collisions; a new one brings the banner back">Dismiss</button>
          <button class="link" id="col-hide" title="Never show this banner (Settings → Pixel Office → Show Collision Radar)">Hide forever</button></div>
          ${shownCollisions.slice(0, 5).map(c => `<div>${esc(c.names.join(' & '))} both edited <code>${esc(c.file.split('/').slice(-2).join('/'))}</code></div>`).join('')}</div>`
      : '')
  for (const el of document.querySelectorAll<HTMLElement>('#attention [data-id]')) el.onclick = () => pick(el.dataset.id!)
  const dismiss = document.getElementById('col-dismiss')
  if (dismiss)
    dismiss.onclick = () => {
      saved.dismissed = v!.collisions.map(collisionKey)
      save()
      render()
    }
  const hide = document.getElementById('col-hide')
  if (hide) hide.onclick = () => post({ type: 'hideCollisions' })
}

// ── the agent console ──────────────────────────────────────────────
// What a developer running agents wants first: what it is working on, its plan and progress,
// what it changed, what broke, and the conversation. Tool calls are folded into "N actions"
// strips (failures flagged in red) and open on a click; "Everything" shows them all expanded.
let consoleKey = ''
let openKeys = new Set<string>()

function buildConsole(box: HTMLElement) {
  box.innerHTML = `
    <div class="c-head"></div>
    <div class="c-brief"></div>
    <div class="c-tools">
      <div class="seg">${(['conversation', 'everything'] as const).map(f => `<button data-f="${f}" title="${f === 'conversation' ? 'Messages, with tool calls folded into summaries' : 'Every tool call, expanded'}">${f === 'conversation' ? 'Conversation' : 'Everything'}</button>`).join('')}</div>
      <span class="grow"></span><span class="c-count dim"></span>
    </div>
    <div class="c-log" tabindex="0"></div>
    <button class="c-latest" hidden>↓ Latest</button>
    <div class="composer"><textarea rows="2"></textarea>
      <div class="row"><button class="primary c-send">Send</button><span class="hint dim"></span></div></div>`
  for (const b of box.querySelectorAll<HTMLButtonElement>('.seg button')) b.onclick = () => ((saved.filter = b.dataset.f as Saved['filter']), save(), (consoleKey = ''), render())
  const log = $('.c-log', box)
  const latest = $<HTMLButtonElement>('.c-latest', box)
  log.onscroll = () => (latest.hidden = isAtBottom(log))
  latest.onclick = () => ((log.scrollTop = log.scrollHeight), (latest.hidden = true))
  const ta = $<HTMLTextAreaElement>('textarea', box)
  const send = () => {
    const text = ta.value.trim()
    if (!v?.selected || !text) return
    post({ type: 'send', id: v.selected, text })
    ta.value = ''
  }
  $<HTMLButtonElement>('.c-send', box).onclick = send
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), send())
  }
}

const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24

function renderConsole(byId: Map<string, Seat>) {
  const box = $('#console')
  const s = v!.selected ? byId.get(v!.selected) : undefined
  box.hidden = isMini || !s
  document.body.classList.toggle('has-console', !box.hidden)
  if (!s || isMini) return
  if (!box.firstChild) buildConsole(box)
  const ins = v!.insights[s.id] ?? {}
  const room = v!.rooms.find(r => r.seatIds.includes(s.id))
  const chat = v!.chat?.id === s.id ? v!.chat : null
  const entries = chat?.entries ?? []

  $('.c-head', box).innerHTML = `
    <div class="c-title"><span class="ic">${ICON[s.state] ?? '●'}</span> <b>${esc(s.name)}</b>
      <span class="pill st-${s.state}">${esc(STATE_LABEL[s.state] ?? s.state)}${s.isAway ? ' · away' : ''}</span><span class="grow"></span>
      <button class="c-jump" title="Focus this session's terminal">Jump</button>
      <button class="c-file" title="Open the raw transcript (.jsonl)" ${ins.hasTranscript ? '' : 'disabled'}>Transcript</button>
      <button class="c-close" title="Close">✕</button></div>
    <div class="c-meta dim">${esc([room ? `📁 ${room.name}` : '', room?.branch ? `⎇ ${room.branch}` : '', ins.changes, ins.tokens].filter(Boolean).join(' · '))}</div>`
  $<HTMLButtonElement>('.c-jump', box).onclick = () => post({ type: 'jump', id: s.id })
  $<HTMLButtonElement>('.c-file', box).onclick = () => post({ type: 'openTranscript', id: s.id })
  $<HTMLButtonElement>('.c-close', box).onclick = () => post({ type: 'select', id: null })
  for (const b of box.querySelectorAll<HTMLButtonElement>('.seg button')) b.classList.toggle('on', b.dataset.f === saved.filter)

  $('.c-brief', box).innerHTML = briefHtml(s, chat?.task ?? '', chat?.plan ?? null, entries)
  $<HTMLButtonElement>('.b-retitle', box).onclick = () => post({ type: 'retitle', id: s.id })

  const ta = $<HTMLTextAreaElement>('textarea', box)
  ta.placeholder = `Message ${s.name}…  (Enter to send · Shift+Enter for a new line)`
  $('.hint', box).innerHTML = s.state === 'needs-you'
    ? `<span class="warnText">Permission prompts are answered in ${esc(s.name)}'s own window (Jump). This message runs after.</span>`
    : `Becomes ${esc(s.name)}'s next prompt once it is idle.`

  // the log is re-rendered only when it changed, keeping what is open and where you scrolled
  const key = `${s.id}|${saved.filter}|${entries.length}|${JSON.stringify(entries.at(-1) ?? '')}`
  if (key === consoleKey) return
  const isNewAgent = !consoleKey.startsWith(`${s.id}|`)
  consoleKey = key
  const log = $('.c-log', box)
  const stick = isNewAgent || isAtBottom(log)
  if (isNewAgent) openKeys = new Set()
  for (const d of log.querySelectorAll<HTMLDetailsElement>('details[data-k]')) d.open ? openKeys.add(d.dataset.k!) : openKeys.delete(d.dataset.k!)
  const all = blocks(entries)
  const tools = entries.filter(e => e.kind === 'tool').length
  $('.c-count', box).textContent = entries.length ? `${entries.length - tools} messages · ${tools} actions` : ''
  log.innerHTML = all.length
    ? all.map(b => (b.kind === 'message' ? messageHtml(b.entry, s.name) : actionsHtml(b))).join('')
    : `<div class="dim empty">No conversation yet${ins.hasTranscript ? '' : ' (the transcript appears after the first turn)'}.</div>`
  if (stick) log.scrollTop = log.scrollHeight
  $<HTMLButtonElement>('.c-latest', box).hidden = isAtBottom(log)
}

/** The top of the console: now, task, plan, changes, problems. */
function briefHtml(s: Seat, task: string, plan: PlanItem[] | null, entries: Entry[]): string {
  const rows: string[] = []
  const now = s.state === 'needs-you' ? `<span class="warnText">❗ ${esc(s.bubble || 'Waiting for you')}</span>` : esc(s.bubble || (s.isBusy ? 'Working' : 'Idle'))
  const title = s.title || s.task
  rows.push(`<div class="b-row"><span class="b-k">Desk</span><span class="b-v">${title ? esc(title) : '<span class="dim">no title yet</span>'}${s.title ? '' : ' <span class="dim">(auto)</span>'}
    <button class="b-retitle link" title="Rename what its desk says; clear it to go back to automatic">✎ Rename</button></span></div>`)
  rows.push(`<div class="b-row"><span class="b-k">Now</span><span class="b-v" title="${esc(s.detail || '')}">${now}${s.detail ? ` <span class="dim detail">${esc(short(s.detail, 90))}</span>` : ''}</span></div>`)
  if (task) rows.push(`<div class="b-row"><span class="b-k">Task</span><span class="b-v">${esc(short(task, 220))}</span></div>`)
  if (plan?.length) {
    const done = plan.filter(p => p.status === 'completed').length
    const pct = Math.round((done / plan.length) * 100)
    rows.push(`<div class="b-row"><span class="b-k">Plan</span><span class="b-v"><progress max="${plan.length}" value="${done}"></progress> ${done}/${plan.length} done · ${pct}%
      <ul class="plan">${plan.map(p => `<li class="${p.status}">${p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '▶' : '○'} ${esc(p.text)}</li>`).join('')}</ul></span></div>`)
  }
  if (s.files.length)
    rows.push(`<div class="b-row"><span class="b-k">Changed</span><span class="b-v">${s.files.slice(0, 6).map(f => `<code title="${esc(f)}">${esc(f.split('/').pop() ?? f)}</code>`).join(' ')}${s.files.length > 6 ? ` <span class="dim">+${s.files.length - 6}</span>` : ''}</span></div>`)
  const failed = entries.filter(e => e.kind === 'tool' && e.isError).slice(-3)
  if (failed.length)
    rows.push(`<div class="b-row"><span class="b-k">Problems</span><span class="b-v">${failed.map(e => `<div class="errText" title="${esc(e.text)}">✗ ${esc(e.tool ?? 'tool')}: ${esc(short(firstLine(e.output ?? ''), 110))}</div>`).join('')}</span></div>`)
  return rows.join('')
}

/** A collision is the same one while the same agents share the same file. */
const collisionKey = (c: { file: string; ids: string[] }) => `${c.file}|${[...c.ids].sort().join(',')}`

const firstLine = (text: string) => text.split('\n').map(l => l.trim()).find(Boolean) ?? ''

function messageHtml(e: Entry, name: string): string {
  return `<div class="e ${e.kind}"><span class="t">${clock(e.at, v!.now)}</span><span class="who">${e.kind === 'you' ? 'you' : esc(name)}</span><div class="body">${markdown(e.text)}</div></div>`
}

function actionsHtml(b: Extract<Block, { kind: 'actions' }>): string {
  const k = `g${b.entries[0]!.index}`
  const isOpen = saved.filter === 'everything' || openKeys.has(k)
  const flags = `${b.failed ? `<span class="flag err">✗ ${b.failed} failed</span>` : ''}${b.running ? `<span class="flag run">running…</span>` : ''}`
  // a hover over the strip lists what ran, without opening it
  const peek = b.entries.slice(-12).map(({ entry }) => `${entry.tool}: ${entry.text}`).join('\n')
  return `<details class="actions${b.failed ? ' failed' : ''}" data-k="${k}"${isOpen ? ' open' : ''}>
    <summary title="${esc(peek)}"><span class="t">${clock(b.at, v!.now)}</span><span class="a-sum">⚙ ${esc(b.summary)}</span>${flags}</summary>
    <div class="a-list">${b.entries.map(({ entry, index }) => toolHtml(entry, index)).join('')}</div></details>`
}

function toolHtml(e: Entry, i: number): string {
  const k = e.callId ?? `i${i}`
  const status = e.output === undefined ? '<span class="run">running…</span>' : e.isError ? '<span class="err">✗</span>' : '<span class="ok">✓</span>'
  return `<details class="tool${e.isError ? ' failed' : ''}" data-k="${esc(k)}"${openKeys.has(k) ? ' open' : ''}>
    <summary><span class="tname">${esc(e.tool ?? 'tool')}</span><code class="targ" title="${esc(e.text)}">${esc(e.text)}</code>${status}</summary>
    ${e.input ? `<div class="lbl">input</div><pre>${esc(e.input)}</pre>` : ''}
    ${e.output !== undefined ? `<div class="lbl">output</div><pre${e.isError ? ' class="err"' : ''}>${esc(e.output || '(empty)')}</pre>` : ''}</details>`
}

// ── the frame around everything ────────────────────────────────────
function render() {
  if (!v) return
  const byId = new Map(v.seats.map(s => [s.id, s]))
  const queue = v.queue.filter(id => byId.has(id))
  $('#summary').textContent = `${v.seats.length} agent${v.seats.length === 1 ? '' : 's'} · ${v.rooms.length} room${v.rooms.length === 1 ? '' : 's'}${queue.length ? ` · ${queue.length} waiting` : ''}`
  const next = $<HTMLButtonElement>('#next')
  next.hidden = !queue.length
  if (queue[0]) next.textContent = `❗ Next: ${short(byId.get(queue[0])!.name, 14)}`

  $('#banner').innerHTML = !v.isEnabled && !v.seats.length
    ? `<div class="card info">Pixel Office isn't on in your Claude Code sessions yet. <button id="enable" class="primary">Enable</button></div>`
    : !v.seats.length ? `<div class="card info">No Claude Code sessions are running. Start one, or press <b>＋ New agent</b>: it walks into its repository's room.</div>` : ''
  document.getElementById('enable')?.addEventListener('click', () => post({ type: 'enable' }))

  renderAttention(byId)
  renderRooms(byId)
  renderConsole(byId)
}

// ── scenes ─────────────────────────────────────────────────────────
function theme(): Theme {
  return document.body.classList.contains('vscode-light') ? { ...DEFAULT_THEME, wall: 0x6f6a8f, trim: 0x55507a, plate: 0x3a3560 } : DEFAULT_THEME
}

function spotlightOf(roomId: string, seats: Seat[], now: number): Spotlight | null {
  const st = v?.standup
  if (!st || (st.request.room && st.request.room !== roomId)) return null
  const here = st.answers.filter(a => seats.some(s => s.id === a.id))
  const id = presenter(here, st.request.requestedAt, now)
  const a = here.find(x => x.id === id)
  return a ? { id: a.id, text: headline(a), isBlocked: !!a.blocked } : null
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
let mono = ''
const monoFont = () => (mono ||= getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim() || 'ui-monospace, Menlo, monospace')

function draw(st: Stage, roomId: string) {
  if (!v || st.el.classList.contains('collapsed')) return
  const now = Date.now()
  const width0 = st.el.querySelector<HTMLElement>('.room-body')!.clientWidth || 300
  const fitted = fit(width0, isMini)
  // a small team gets a small office: no wider than its desks need, at the same scale
  const width = Math.min(fitted.width, Math.max(46, st.seats.length * 22 + 2))
  const L = layout(width, st.seats.length)
  // full screen: the same office, zoomed to the biggest whole scale that fits
  const box = st.canvas.parentElement!
  const scale = box.classList.contains('full') ? Math.max(1, Math.floor(Math.min(box.clientWidth / L.w, box.clientHeight / L.h))) : fitted.scale
  const desk = assignDesks(st.seats.map(s => s.id), L.desks.length)
  Object.assign(st, { L, desk, scale })
  const f = drawOffice(L, st.seats, desk, now, theme(), spotlightOf(roomId, st.seats, now))

  if (st.off.width !== L.w || st.off.height !== L.h) (st.off.width = L.w), (st.off.height = L.h)
  const img = st.offCtx.createImageData(L.w, L.h)
  for (let i = 0; i < f.px.length; i++) {
    const c = f.px[i]!
    img.data[i * 4] = (c >> 16) & 255
    img.data[i * 4 + 1] = (c >> 8) & 255
    img.data[i * 4 + 2] = c & 255
    img.data[i * 4 + 3] = 255
  }
  st.offCtx.putImageData(img, 0, 0)
  const dpr = window.devicePixelRatio || 1
  const cssW = L.w * scale
  const cssH = L.h * scale
  const { canvas, ctx } = st
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(st.off, 0, 0, cssW, cssH)

  ctx.font = `${Math.max(9, Math.round(scale * 1.55))}px ${monoFont()}`
  ctx.textBaseline = 'middle'
  for (const t of f.texts) {
    const x = t.col * scale
    const y = t.row * 2 * scale
    ctx.fillStyle = hex(t.bg)
    ctx.fillRect(x, y, Math.max(ctx.measureText(t.text).width, [...t.text].length * scale * 0.6) + 2, 2 * scale)
    ctx.fillStyle = hex(t.fg)
    ctx.fillText(t.text, x + 1, y + scale + 0.5)
  }
  // the selected agent gets a focus ring on its desk
  const sel = v.selected ? L.desks[desk.get(v.selected) ?? -1] : undefined
  if (sel) {
    ctx.strokeStyle = 'rgba(80, 160, 255, 0.95)'
    ctx.lineWidth = 2
    ctx.strokeRect(sel.x * scale + 1, sel.y * scale + 1, 22 * scale - 2, 22 * scale - 2)
  }
  // collision radar: a pulsing red line between desks of agents on the same file
  ctx.strokeStyle = `rgba(255, 70, 70, ${0.55 + 0.45 * Math.sin(now / 250)})`
  ctx.lineWidth = Math.max(2, scale / 2)
  ctx.setLineDash([scale * 2, scale])
  for (const c of v.collisions)
    for (let i = 1; i < c.ids.length; i++) {
      const a = L.desks[desk.get(c.ids[i - 1]!) ?? -1]
      const b = L.desks[desk.get(c.ids[i]!) ?? -1]
      if (!a || !b) continue
      const p = deskCentre(a, scale)
      const q = deskCentre(b, scale)
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(q.x, q.y)
      ctx.stroke()
    }
  ctx.setLineDash([])
}

let last = 0
function loop(t: number) {
  if (!document.hidden && t - last > 33) {
    last = t
    for (const [id, st] of stages) draw(st, id)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

function seatAt(st: Stage, e: MouseEvent): Seat | null {
  const r = st.canvas.getBoundingClientRect()
  const { col, row } = cellAt(e.clientX - r.left, e.clientY - r.top, st.scale)
  const id = hitTest(st.L, st.desk, col, row)
  return st.seats.find(s => s.id === id) ?? null
}

function hover(st: Stage, e: MouseEvent) {
  const s = seatAt(st, e)
  st.canvas.style.cursor = s ? 'pointer' : 'default'
  if (!s) return void (st.card.hidden = true)
  const ins = v?.insights[s.id] ?? {}
  const facts = [ins.changes, ins.tokens, `${s.turns} turns`, `${s.tools} tools`].filter(Boolean)
  st.card.innerHTML = `<b>${ICON[s.state] ?? '●'} ${esc(s.name)}</b> <span class="dim">${esc(STATE_LABEL[s.state] ?? s.state)}${s.isAway ? ' · away' : ''}</span>
    ${s.bubble ? `<div class="quote">${esc(s.bubble)}</div>` : ''}${s.detail ? `<div class="file dim">${esc(short(s.detail, 120))}</div>` : ''}<div class="dim">${esc(facts.join(' · '))}</div>
    ${s.files.slice(0, 3).map(f => `<div class="file">✏️ ${esc(f.split('/').pop() ?? f)}</div>`).join('')}
    <div class="dim tip">${isMini ? 'Click to open its console' : 'Click to open its console'}</div>`
  st.card.hidden = false
  const box = st.canvas.parentElement!.getBoundingClientRect()
  st.card.style.left = `${Math.max(4, Math.min(e.clientX - box.left + 14, box.width - 230))}px`
  st.card.style.top = `${Math.min(e.clientY - box.top + 14, Math.max(4, box.height - 120))}px`
}
