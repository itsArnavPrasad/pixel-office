// The office page: a canvas scene drawn by the shared core, plus cards, chips and the dialogue.
import { formatWait } from '../../pixel-office/hooks/core/alerts'
import { assignDesks, type Seat } from '../../pixel-office/hooks/core/roster'
import { DEFAULT_THEME, drawOffice, hitTest, layout, type Spotlight, type Theme } from '../../pixel-office/hooks/core/scene'
import { headline, PENDING_MS, presenter } from '../../pixel-office/hooks/core/standup'
import type { FromWebview, ViewState } from '../src/protocol'
import { cellAt, deskCentre, fit } from './geometry'

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void }
const vscode = acquireVsCodeApi()
const isMini = document.body.classList.contains('mode-mini')

const ICON: Record<string, string> = {
  arriving: '🚶', idle: '○', thinking: '💭', typing: '⌨️', reading: '📖', writing: '✏️', browsing: '🌐',
  delegating: '👥', working: '●', 'needs-you': '❗', stressed: '💦', done: '✓', leaving: '👋',
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const short = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s)

let v: ViewState | null = null
let hoverId: string | null = null

// ── skeleton: the composer is built once so typing survives redraws ──
const app = document.getElementById('app')!
app.innerHTML = `
  <header><span class="title">🏢 Pixel Office</span><span id="summary"></span><span class="grow"></span>
    <button id="next" class="primary" hidden>❗ Next</button><button id="standup">🗣 Standup</button></header>
  <div id="banner"></div><div id="queue"></div><div id="collisions"></div>
  <div class="stage"><canvas id="office"></canvas><div id="card" hidden></div></div>
  <div id="chips"></div>
  <section id="dialogue" hidden><div id="dlg-head"></div><div id="dlg-lines"></div>
    <div class="composer"><textarea id="reply" rows="2" placeholder="Message…"></textarea>
      <div class="row"><button id="send" class="primary">Send</button><button id="jump">Jump to session</button><span class="grow"></span><button id="close">Close</button></div>
      <div id="hint"></div></div></section>
  <div id="standup-card"></div>`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('office')
const ctx = canvas.getContext('2d')!
const off = document.createElement('canvas')
const offCtx = off.getContext('2d')!
const reply = $<HTMLTextAreaElement>('reply')

const post = (m: FromWebview) => vscode.postMessage(m)
$('standup').onclick = () => post({ type: 'standup' })
$('next').onclick = () => v?.queue[0] && post({ type: 'select', id: v.queue[0] })
$('close').onclick = () => post({ type: 'select', id: null })
$('jump').onclick = () => v?.selected && post({ type: 'jump', id: v.selected })
const send = () => {
  const text = reply.value.trim()
  if (!v?.selected || !text) return
  post({ type: 'send', id: v.selected, text })
  reply.value = ''
}
$('send').onclick = send
reply.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), send())
}

window.addEventListener('message', e => {
  if (e.data?.type !== 'view') return
  const was = v?.selected
  v = e.data as ViewState
  renderDom()
  if (v.selected && v.selected !== was) reply.focus()
})
post({ type: 'ready' })

// ── the scene ────────────────────────────────────────────────────
function theme(): Theme {
  const light = document.body.classList.contains('vscode-light')
  return light ? { ...DEFAULT_THEME, wall: 0x6f6a8f, trim: 0x55507a, plate: 0x3a3560 } : DEFAULT_THEME
}

function spotlightOf(seats: Seat[], now: number): Spotlight | null {
  const st = v?.standup
  if (!st) return null
  const here = st.answers.filter(a => seats.some(s => s.id === a.id))
  const id = presenter(here, st.request.requestedAt, now)
  const a = here.find(x => x.id === id)
  return a ? { id: a.id, text: headline(a), isBlocked: !!a.blocked } : null
}

let geo = { width: 0, scale: 2, L: layout(46, 1), desk: new Map<string, number>() }

function draw() {
  if (!v) return
  const now = Date.now()
  // measure the page column, not the stage: the stage takes the canvas's own size
  const { width, scale } = fit(app.clientWidth || 300, isMini)
  const L = layout(width, v.seats.length)
  const desk = assignDesks(v.seats.map(s => s.id), L.desks.length)
  geo = { width, scale, L, desk }
  const f = drawOffice(L, v.seats, desk, now, theme(), spotlightOf(v.seats, now))

  // pixels: core frame → ImageData → scaled crisp
  if (off.width !== L.w || off.height !== L.h) (off.width = L.w), (off.height = L.h)
  const img = offCtx.createImageData(L.w, L.h)
  for (let i = 0; i < f.px.length; i++) {
    const c = f.px[i]!
    img.data[i * 4] = (c >> 16) & 255
    img.data[i * 4 + 1] = (c >> 8) & 255
    img.data[i * 4 + 2] = c & 255
    img.data[i * 4 + 3] = 255
  }
  offCtx.putImageData(img, 0, 0)
  const dpr = window.devicePixelRatio || 1
  const cssW = L.w * scale
  const cssH = L.h * scale
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(off, 0, 0, cssW, cssH)

  // text: real fonts on the cell grid
  const size = Math.max(9, Math.round(scale * 1.55))
  ctx.font = `${size}px ${monoFont()}`
  ctx.textBaseline = 'middle'
  for (const t of f.texts) {
    const x = t.col * scale
    const y = t.row * 2 * scale
    const w = Math.max(ctx.measureText(t.text).width, [...t.text].length * scale * 0.6)
    ctx.fillStyle = hex(t.bg)
    ctx.fillRect(x, y, w + 2, 2 * scale)
    ctx.fillStyle = hex(t.fg)
    ctx.fillText(t.text, x + 1, y + scale + 0.5)
  }

  // collision radar: a pulsing red line between the desks of agents on the same file
  const pulse = 0.55 + 0.45 * Math.sin(now / 250)
  ctx.strokeStyle = `rgba(255, 70, 70, ${pulse})`
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

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
// a canvas font cannot read CSS variables, so resolve the editor's font family once
let mono = ''
const monoFont = () =>
  (mono ||= getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim() || 'ui-monospace, Menlo, monospace')

let last = 0
function loop(t: number) {
  if (!document.hidden && t - last > 33) (last = t), draw()
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// ── pointer: click to talk, hover for a card ─────────────────────
function seatAt(e: MouseEvent): Seat | null {
  const r = canvas.getBoundingClientRect()
  const { col, row } = cellAt(e.clientX - r.left, e.clientY - r.top, geo.scale)
  const id = hitTest(geo.L, geo.desk, col, row)
  return v?.seats.find(s => s.id === id) ?? null
}
canvas.onclick = e => {
  const s = seatAt(e)
  if (s) post({ type: 'select', id: s.id })
}
canvas.onmousemove = e => {
  const s = seatAt(e)
  canvas.style.cursor = s ? 'pointer' : 'default'
  const card = $('card')
  if (!s) return void ((card.hidden = true), (hoverId = null))
  hoverId = s.id
  card.hidden = false
  card.innerHTML = cardHtml(s)
  // the card is placed in the stage, which centres the canvas
  const r = canvas.parentElement!.getBoundingClientRect()
  const x = Math.min(e.clientX - r.left + 14, r.width - 230)
  card.style.left = `${Math.max(4, x)}px`
  card.style.top = `${Math.min(e.clientY - r.top + 14, Math.max(4, r.height - 120))}px`
}
canvas.onmouseleave = () => (($('card').hidden = true), (hoverId = null))

function cardHtml(s: Seat): string {
  const ins = v?.insights[s.id] ?? {}
  const facts = [ins.where, ins.changes, ins.tokens && `${ins.tokens} tokens`, `${s.turns} turns`, `${s.tools} tools`].filter(Boolean)
  const files = s.files.slice(0, 3).map(f => `<div class="file">✏️ ${esc(f.split('/').pop() ?? f)}</div>`).join('')
  return `<b>${ICON[s.state] ?? '●'} ${esc(s.name)}</b> <span class="dim">${esc(s.state)}${s.isAway ? ' · away' : ''}</span>
    ${s.bubble ? `<div class="quote">“${esc(s.bubble)}”</div>` : ''}<div class="dim">${esc(facts.join(' · '))}</div>${files}
    <div class="dim tip">Click to talk</div>`
}

// ── the DOM around the scene ─────────────────────────────────────
function renderDom() {
  if (!v) return
  const now = v.now
  const byId = new Map(v.seats.map(s => [s.id, s]))
  const queue = v.queue.map(id => byId.get(id)).filter((s): s is Seat => !!s)

  $('summary').textContent = `${v.seats.length} agent${v.seats.length === 1 ? '' : 's'}${queue.length ? ` · ${queue.length} waiting` : ''}`
  const next = $<HTMLButtonElement>('next')
  next.hidden = !queue.length
  if (queue[0]) next.textContent = `❗ Next: ${short(queue[0].name, 14)}`

  $('banner').innerHTML = !v.isEnabled && !v.seats.length
    ? `<div class="card info">Pixel Office isn't on in your Claude Code sessions yet. <button id="enable" class="primary">Enable</button></div>`
    : !v.seats.length ? `<div class="card info">No Claude Code sessions are running. Start one and it walks in.</div>` : ''
  document.getElementById('enable')?.addEventListener('click', () => post({ type: 'enable' }))

  $('queue').innerHTML = queue.length
    ? `<div class="card warn"><b>❗ Needs you (${queue.length})</b>${queue.slice(0, isMini ? 3 : 6).map(s =>
        `<div class="qrow" data-id="${esc(s.id)}"><b>${esc(short(s.name, 22))}</b> <span class="dim">waiting ${formatWait(now - s.since)}</span> ${esc(short(s.bubble, 80))}</div>`).join('')}</div>`
    : ''
  $('collisions').innerHTML = v.collisions.length
    ? `<div class="card danger"><b>⚠ Collision radar</b>${v.collisions.slice(0, 5).map(c =>
        `<div>${esc(c.names.join(' & '))} both edited <code>${esc(c.file.split('/').slice(-2).join('/'))}</code></div>`).join('')}</div>`
    : ''

  const sorted = [...v.seats].sort((a, b) => Number(b.state === 'needs-you') - Number(a.state === 'needs-you') || a.name.localeCompare(b.name))
  $('chips').innerHTML = sorted.map(s =>
    `<button class="chip${s.state === 'needs-you' ? ' warn' : ''}${s.id === v!.selected ? ' on' : ''}${s.isAway ? ' away' : ''}" data-id="${esc(s.id)}">${ICON[s.state] ?? '●'} ${esc(short(s.name, 18))}</button>`).join('')

  for (const el of document.querySelectorAll<HTMLElement>('[data-id]')) el.onclick = () => post({ type: 'select', id: el.dataset.id! })

  renderDialogue(byId)
  renderStandup(byId, now)
  if (hoverId && byId.get(hoverId)) $('card').innerHTML = cardHtml(byId.get(hoverId)!)
}

function renderDialogue(byId: Map<string, Seat>) {
  const s = v?.selected ? byId.get(v.selected) : undefined
  const box = $('dialogue')
  box.hidden = !s
  if (!s) return
  const ins = v!.insights[s.id] ?? {}
  const facts = [s.state + (s.isAway ? ' · away' : ''), ins.where, ins.changes, ins.tokens && `${ins.tokens} tokens`].filter(Boolean)
  $('dlg-head').innerHTML = `<b>${ICON[s.state] ?? '●'} ${esc(s.name)}</b> <span class="dim">${esc(facts.join(' · '))}</span>
    ${s.bubble ? `<div class="quote">“${esc(s.bubble)}”</div>` : ''}`
  const lines = ins.lines ?? []
  $('dlg-lines').innerHTML = lines.length
    ? lines.slice(isMini ? -4 : -8).map(l => `<div class="line ${l.who}"><b>${l.who === 'you' ? 'you' : l.who === 'tool' ? '⚙' : esc(s.name)}</b> ${esc(short(l.text, 300))}</div>`).join('')
    : `<div class="dim">No conversation to show yet.</div>`
  reply.placeholder = `Message ${s.name}… (Enter to send, Shift+Enter for a new line)`
  $('hint').innerHTML = s.state === 'needs-you'
    ? `<div class="warnText">Permission prompts are answered in ${esc(s.name)}'s own window or terminal (use Jump). A message sent here runs after it.</div>`
    : `<div class="dim">Your message becomes ${esc(s.name)}'s next prompt once it is idle.</div>`
}

function renderStandup(byId: Map<string, Seat>, now: number) {
  const st = v?.standup
  const el = $('standup-card')
  if (!st) return void (el.innerHTML = '')
  const rows = new Map<string, { name: string; a?: (typeof st.answers)[number] }>()
  for (const s of byId.values()) rows.set(s.id, { name: s.name })
  for (const a of st.answers) rows.set(a.id, { name: a.name, a })
  const late = now - st.request.requestedAt > PENDING_MS
  el.innerHTML = `<div class="card ok"><b>🗣 Standup</b> <span class="dim">called by ${esc(st.request.by)} ${formatWait(now - st.request.requestedAt)} ago</span>
    ${[...rows.values()].map(({ name, a }) => a
      ? `<div class="su"><b>${esc(name)}</b>${a.done ? `<div>✓ ${esc(a.done)}</div>` : ''}${a.next ? `<div class="dim">→ ${esc(a.next)}</div>` : ''}${a.blocked ? `<div class="warnText">❗ ${esc(a.blocked)}</div>` : ''}</div>`
      : `<div class="su dim"><b>${esc(name)}</b> ${late ? '(no answer)' : '… thinking'}</div>`).join('')}</div>`
}
