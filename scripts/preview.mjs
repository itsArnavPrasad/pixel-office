// Renders sample offices to PNG/SVG for eyeballing: node scripts/preview.mjs <outdir>
import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
registerHooks({
  resolve: (spec, ctx, next) => {
    try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e }
  },
})
Uint8Array.prototype.toBase64 ??= function () { return Buffer.from(this).toString('base64') }
const core = new URL('../pixel-office/hooks/core/', import.meta.url)
const { layout, drawOffice } = await import(new URL('scene.ts', core))
const { assignDesks } = await import(new URL('roster.ts', core))
const { newAgent } = await import(new URL('agent.ts', core))
const { toSvg } = await import(new URL('encode.ts', core))
const out = process.argv[2] ?? '.'
const now = 1_759_400_100_000
const states = [
  ['api-server', 'typing', '$ npm test -- --watch=false', 'dev-1'],
  ['web', 'needs-you', 'Can I run rm -rf build?', 'dev-2'],
  ['docs', 'idle', '', 'dev-3'],
  ['infra', 'reading', 'terraform.tf', 'dev-4'],
  ['mobile', 'writing', '✎ App.tsx', 'dev-5'],
  ['ml', 'done', 'Trained the model, loss 0.12.', 'dev-6'],
  ['search', 'browsing', 'docs.anthropic.com', 'dev-7'],
  ['billing', 'stressed', 'Hmm, that failed…', 'dev-8'],
  ['new', 'arriving', 'Morning!', 'dev-1'],
]
const seats = states.map(([name, state, bubble, character], i) => ({
  ...newAgent('s' + i, now - 1500), name, state, bubble, character, since: state === 'idle' ? now - 90_000 : now - 1500,
  interns: name === 'infra' ? 2 : 0, isAway: name === 'docs', isMe: i === 0,
}))
for (const [cols, n] of [[120, 9], [70, 3], [40, 1]]) {
  const L = layout(cols, n)
  const desk = assignDesks(seats.slice(0, n).map(s => s.id), L.desks.length)
  const f = drawOffice(L, seats.slice(0, n), desk, now)
  // texts: paint plates + a dark glyph pixel pattern so placement shows
  for (const t of f.texts) for (let i = 0; i < [...t.text].length; i++) for (const dy of [0, 1]) {
    const x = t.col + i, y = t.row * 2 + dy; if (x < f.w && y < f.h) f.px[y * f.w + x] = (t.text[i] === ' ' || dy) ? t.bg : t.fg
  }
  const S = 8, W = f.w * S, H = f.h * S, buf = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = f.px[Math.floor(y / S) * f.w + Math.floor(x / S)], o = (y * W + x) * 3
    buf[o] = c >> 16 & 255; buf[o + 1] = c >> 8 & 255; buf[o + 2] = c & 255
  }
  const base = `${out}/office-${cols}`
  writeFileSync(base + '.ppm', Buffer.concat([Buffer.from(`P6 ${W} ${H} 255\n`), buf]))
  execFileSync('sips', ['-s', 'format', 'png', base + '.ppm', '--out', base + '.png'], { stdio: 'ignore' })
  const svg = toSvg(drawOffice(L, seats.slice(0, n), desk, now), 6)
  writeFileSync(base + '.svg', svg)
  console.log(base, `${f.w}x${f.h}px`, 'svg chars', svg.length)
}
