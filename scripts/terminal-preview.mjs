// Renders what the office looks like inside a fullscreen terminal, from the mod's real Raster cells.
// node scripts/terminal-preview.mjs <outdir>   → <outdir>/terminal-*.html (+ .png via headless Chrome)
import { registerHooks } from 'node:module'
import { writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
registerHooks({
  resolve: (s, c, n) => { try { return n(s, c) } catch (e) { if (s.startsWith('.')) return n(s + '.ts', c); throw e } },
})
Uint8Array.prototype.toBase64 ??= function () { return Buffer.from(this).toString('base64') }

const core = new URL('../pixel-office/hooks/core/', import.meta.url)
const { layout, drawOffice } = await import(new URL('scene.ts', core))
const { assignDesks, mergeRoster } = await import(new URL('roster.ts', core))
const { newAgent } = await import(new URL('agent.ts', core))
const { toRasterWords } = await import(new URL('encode.ts', core))
const { headline } = await import(new URL('standup.ts', core))

const out = process.argv[2] ?? '.'
const COLS = 200, ROWS = 54, CW = 9, CH = 18
const C = {
  bg: '#16161e', fg: '#c9ccd6', dim: '#6b7089', accent: '#d97757', yellow: '#e0af68', green: '#9ece6a',
  border: '#3b3f55', blue: '#7aa2f7', white: '#ffffff', you: '#bb9af7',
}
const WIDE = new Set([...'❗💭📖🌐👥🗣🏢📨💦👋🚶⌨'])

function grid() {
  const g = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ ch: ' ', fg: C.fg, bg: C.bg })))
  const put = (x, y, text, fg = C.fg, bg, bold) => {
    for (const ch of text) {
      if (y < 0 || y >= ROWS || x >= COLS) return
      if (x >= 0) g[y][x] = { ch, fg, bg: bg ?? g[y][x].bg, bold, wide: WIDE.has(ch) }
      if (WIDE.has(ch) && x + 1 < COLS) g[y][x + 1] = { skip: true, bg: bg ?? g[y][x + 1].bg }
      x += WIDE.has(ch) ? 2 : 1
    }
  }
  const box = (x, y, w, h, color = C.border, title) => {
    put(x, y, '╭' + '─'.repeat(w - 2) + '╮', color)
    for (let j = 1; j < h - 1; j++) put(x, y + j, '│', color), put(x + w - 1, y + j, '│', color)
    put(x, y + h - 1, '╰' + '─'.repeat(w - 2) + '╯', color)
    if (title) put(x + 2, y, ` ${title} `, color, undefined, true)
  }
  const raster = (x, y, f) => {
    const words = toRasterWords(f)
    const hex = c => '#' + c.toString(16).padStart(6, '0')
    for (let r = 0; r < f.h / 2; r++) for (let c = 0; c < f.w; c++) {
      const i = (r * f.w + c) * 3
      if (y + r >= ROWS || x + c >= COLS) continue
      g[y + r][x + c] = { ch: String.fromCodePoint(words[i]), fg: hex(words[i + 1]), bg: hex(words[i + 2]), px: words[i] === 0x2580 }
    }
  }
  return { g, put, box, raster }
}

function html(g, title) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const rows = g.map(row => row.map(c => {
    if (c.skip) return ''
    if (c.px) return `<i style="background:linear-gradient(${c.fg} 50%,${c.bg} 50%)"></i>`
    const w = c.wide ? ` class="w"` : ''
    return `<b${w} style="color:${c.fg};background:${c.bg}${c.bold ? ';font-weight:700' : ''}">${esc(c.ch)}</b>`
  }).join('')).map(r => `<div>${r}</div>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
  body{margin:0;background:#0b0b10;padding:24px;font:15px/18px Menlo,"SF Mono",monospace}
  .win{width:${COLS * CW}px;border-radius:10px;overflow:hidden;box-shadow:0 20px 60px #000a;border:1px solid #2a2d3d}
  .bar{height:30px;background:#232433;display:flex;align-items:center;gap:8px;padding:0 12px;color:#8a8fa8;font:13px -apple-system,sans-serif}
  .dot{width:12px;height:12px;border-radius:50%}.bar span{margin-left:auto;margin-right:auto}
  .term{background:${C.bg}} .term div{height:${CH}px;white-space:pre;display:flex}
  b,i{display:inline-block;width:${CW}px;height:${CH}px;font-weight:400;text-align:center;overflow:visible}
  b.w{width:${CW * 2}px} i{font-style:normal}
  </style><div class="win"><div class="bar"><div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div><span>${title}</span></div><div class="term">${rows}</div></div>`
}

const NOW = 1_790_000_000_000 // a moment where the ❗ blink is on
const T0 = NOW - 600_000
const A = (id, name, character, state, bubble, over = {}) => ({
  ...newAgent(id, T0), name, character, state, bubble, joinedAt: T0 + id.charCodeAt(0), since: NOW - 4000, heartbeat: NOW,
  isBusy: state !== 'idle', turns: 6, tools: 40, cwd: `/Users/dev/code/${name}`, ...over,
})
const me = A('a-me', 'first', 'dev-1', 'typing', 'Running tests', { turns: 9, tools: 63 })
const crowd = [
  A('b-web', 'web-app', 'dev-2', 'needs-you', 'Allow Bash: rm -rf dist?', { since: NOW - 134_000 }),
  A('c-api', 'api', 'dev-3', 'reading', 'Reading auth.controller.ts', { interns: 2 }),
  A('d-infra', 'infra', 'dev-4', 'writing', 'Editing main.tf'),
  A('e-docs', 'docs', 'dev-5', 'idle', '', { since: NOW - 300_000 }),
  A('f-ml', 'ml-train', 'dev-6', 'done', 'Loss is down to 0.12.'),
]
const ICON = { idle: '○', thinking: '💭', typing: '⌨', reading: '📖', writing: '✎', browsing: '🌐', delegating: '👥', 'needs-you': '❗', done: '✓' }

function transcript(t, x0, w) {
  const lines = [
    ['user', '> the login test is flaky on CI, can you find out why and fix it'],
    ['', ''],
    ['bot', '⏺ I\'ll start by running the test a few times to see how it fails.'],
    ['', ''],
    ['tool', '⏺ Bash(npm test -- login.spec.ts --runs=5)'],
    ['out', '  ⎿  4 passed, 1 failed: "session cookie expired" (timing)'],
    ['', ''],
    ['bot', '⏺ It fails when the clock crosses the token\'s expiry mid-test.'],
    ['bot', '  The fixture issues a token with a 1 s lifetime. I\'ll freeze the'],
    ['bot', '  clock in the fixture instead of sleeping.'],
    ['', ''],
    ['tool', '⏺ Update(tests/fixtures/session.ts)'],
    ['out', '  ⎿  Updated with 3 additions and 2 removals'],
    ['', ''],
    ['tool', '⏺ Bash(npm test -- login.spec.ts --runs=20)'],
    ['dim', '  ⎿  Running… (12s)'],
  ]
  lines.forEach(([k, s], i) => {
    const color = { user: C.fg, bot: C.fg, tool: C.green, out: C.dim, dim: C.dim }[k] ?? C.fg
    t.put(x0, 1 + i, s.slice(0, w), color, undefined, k === 'user')
  })
  t.put(x0, 1 + lines.length + 1, '✻ Running tests… (esc to interrupt)', C.accent)
}

function bottom(t, band, status) {
  let y = ROWS - 7
  if (band) {
    t.put(1, y, band.text, C.yellow)
    t.put(2 + [...band.text].length + 1, y, `[ ${band.button} ]`, C.white, '#3a2f6b', true)
  }
  y = ROWS - 6
  t.box(0, y, COLS, 3, C.border)
  t.put(2, y + 1, '>', C.dim)
  t.put(4, y + 1, band?.draft ?? '', C.fg)
  t.put(2, ROWS - 3, '? for shortcuts', C.dim)
  if (status) t.put(COLS - [...status].length - 2, ROWS - 3, status, C.fg)
  t.put(2, ROWS - 2, '⏵⏵ auto mode on (shift+tab to cycle)', C.dim)
}

function pane(t, x0, w, seats, { spot = null, selected = null, standup = null, typed = '' } = {}) {
  const inner = w - 4
  const height = ROWS - 8
  t.box(x0, 0, w, height, C.border, 'Pixel Office')
  let y = 1
  const queue = seats.filter(s => s.state === 'needs-you' && !s.isMe)
  if (queue.length && !standup) {
    t.box(x0 + 2, y, inner, 2 + queue.length, C.yellow)
    t.put(x0 + 4, y, ` ❗ Needs you (${queue.length}) `, C.yellow, undefined, true)
    queue.forEach((s, i) => {
      const m = Math.round((NOW - s.since) / 60000)
      t.put(x0 + 4, y + 1 + i, s.name, C.fg, undefined, true)
      t.put(x0 + 5 + s.name.length, y + 1 + i, `· waiting ${m}m · ${s.bubble}`, C.fg)
    })
    y += 2 + queue.length
  }
  const L = layout(inner, seats.length)
  const desk = assignDesks(seats.map(s => s.id), L.desks.length)
  t.raster(x0 + 2, y, drawOffice(L, seats, desk, NOW, undefined, spot))
  y += L.h / 2 + 1
  let x = x0 + 2
  const btn = (label, isPrimary) => {
    const s = `[ ${label} ]`
    t.put(x, y, s, isPrimary ? C.white : C.fg, isPrimary ? '#3a2f6b' : '#24273a', isPrimary)
    x += [...s].length + [...s].filter(c => WIDE.has(c)).length + 1
  }
  if (queue[0]) btn(`❗ Next: ${queue[0].name}`, true)
  btn('🗣 Standup', false)
  y += 1
  x = x0 + 2
  const sorted = [...seats].sort((a, b) => (a.state === 'needs-you' ? -1 : 0) - (b.state === 'needs-you' ? -1 : 0))
  sorted.forEach((s, i) => {
    const label = `${i + 1}: ${ICON[s.state] ?? '●'} ${s.name}${s.isMe ? ' (here)' : ''}`
    const width = [...label].length + [...label].filter(c => WIDE.has(c)).length + 4
    if (x + width > x0 + w - 2) (y += 1), (x = x0 + 2)
    btn(label.slice(3), s.state === 'needs-you')
  })
  y += 2
  if (selected) {
    const s = seats.find(z => z.id === selected)
    const log = [
      ['api', '📖 auth.controller.ts'],
      ['api', 'Refresh tokens now rotate on every use.'],
      ['you', 'great, also add rate limiting to /login'],
      ['api', '✎ middleware/rate-limit.ts'],
    ]
    t.box(x0 + 2, y, inner, 9, C.border)
    t.put(x0 + 4, y + 1, `${ICON[s.state]} ${s.name}`, C.fg, undefined, true)
    t.put(x0 + 8 + s.name.length, y + 1, `· ${s.state} · ${s.turns} turns · ${s.tools} tools · ${s.name}`, C.dim)
    t.put(x0 + 4, y + 2, `“${s.bubble}”`, C.fg)
    log.forEach(([who, text], i) => {
      t.put(x0 + 4, y + 3 + i, `${who}:`, who === 'you' ? C.you : C.dim, undefined, true)
      t.put(x0 + 5 + who.length + 1, y + 3 + i, text, who === 'you' ? C.fg : C.dim)
    })
    t.box(x0 + 4, y + 7 - 1, inner - 14, 3, C.accent)
    t.put(x0 + 6, y + 7, typed || `Message ${s.name}…`, typed ? C.fg : C.dim)
    t.put(x0 + 6 + [...typed].length, y + 7, '█', C.fg)
    t.put(x0 + inner - 8, y + 7, '[ Send ]', C.white, '#3a2f6b', true)
    y += 9
  }
  if (standup) {
    const rows = standup.flatMap(a => [a.name, a.done && `  ✓ ${a.done}`, a.next && `  → ${a.next}`, a.blocked && `  ❗ ${a.blocked}`].filter(Boolean).map((l, i) => [l, a, i]))
    t.box(x0 + 2, y, inner, rows.length + 2, C.green)
    t.put(x0 + 4, y, ' 🗣 Standup ', C.green, undefined, true)
    t.put(x0 + 17, y, ' called by first 40s ago ', C.dim)
    rows.forEach(([l, , i], j) => t.put(x0 + 4, y + 1 + j, l, i === 0 ? C.fg : l.includes('❗') ? C.yellow : l.includes('→') ? C.dim : C.fg, undefined, i === 0))
  }
}

function render(name, title, build) {
  const t = grid()
  build(t)
  const file = `${out}/terminal-${name}.html`
  writeFileSync(file, html(t.g, title))
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(chrome)) {
    execFileSync(chrome, ['--headless=new', '--hide-scrollbars', `--screenshot=${out}/terminal-${name}.png`,
      `--window-size=${COLS * CW + 48},${ROWS * CH + 30 + 48}`, pathToFileURL(resolve(file)).href], { stdio: 'ignore' })
  }
  console.log(name)
}

const SPLIT = 86
const seatsOf = (list, now = NOW) => mergeRoster(list, me, now)

render('1-busy', 'claude — ~/code/first', t => {
  transcript(t, 1, SPLIT - 2)
  pane(t, SPLIT, COLS - SPLIT, seatsOf(crowd))
  bottom(t, { text: '❗ 1 waiting: web-app 2m', button: 'Open web-app' }, '🏢 6 in the office · ❗ 1 needs you')
})

render('2-dialogue', 'claude — ~/code/first', t => {
  transcript(t, 1, SPLIT - 2)
  pane(t, SPLIT, COLS - SPLIT, seatsOf(crowd), { selected: 'c-api', typed: 'and add a test for the 429 response' })
  bottom(t, { text: '❗ 1 waiting: web-app 2m', button: 'Open web-app' }, '🏢 6 in the office · ❗ 1 needs you')
})

const answers = [
  { id: 'a-me', name: 'first', done: 'Fixed the flaky login test (frozen clock).', next: 'Run it 20× on CI.', blocked: '' },
  { id: 'c-api', name: 'api', done: 'Added JWT refresh rotation + 12 tests.', next: 'Rate limiting on /login.', blocked: '' },
  { id: 'b-web', name: 'web-app', done: 'Built the settings page.', next: 'Clean dist and redeploy.', blocked: 'Approve rm -rf dist in my window.' },
].map((a, i) => ({ v: 1, character: 'dev-1', at: NOW - 30_000 + i, ...a }))
render('3-standup', 'claude — ~/code/first', t => {
  transcript(t, 1, SPLIT - 2)
  const spot = { id: 'c-api', text: headline(answers[1]), isBlocked: false }
  pane(t, SPLIT, COLS - SPLIT, seatsOf(crowd), { spot, standup: answers })
  bottom(t, null, '🏢 6 in the office · ❗ 1 needs you')
})
