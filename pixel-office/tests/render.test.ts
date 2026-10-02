import { describe, expect, test } from 'claude-code/testing'

import type { AgentState } from '../types'
import { newAgent } from '../hooks/core/agent'
import { isCellChar, toRasterWords, toSvg } from '../hooks/core/encode'
import { blit, frame, rect, text } from '../hooks/core/pixels'
import { assignDesks, type Seat } from '../hooks/core/roster'
import { CELL_H, CELL_W, MAX_ROWS, PLAY_H, drawOffice, hitTest, layout, styles } from '../hooks/core/scene'
import * as art from '../hooks/core/sprites'

const NOW = 1_759_400_100_000
const ALL: AgentState[] = ['arriving', 'idle', 'thinking', 'typing', 'reading', 'writing', 'browsing', 'delegating', 'working', 'needs-you', 'stressed', 'done', 'leaving']
const seat = (i: number, state: AgentState, over: Partial<Seat> = {}): Seat => ({
  ...newAgent(`s${i}`, NOW - 1000), name: `agent-${i}`, state, bubble: `bubble ${i} with some words`, isAway: false, isMe: i === 0, ...over,
})

describe('sprites', () => {
  test('every sprite is rectangular and uses only its palette', () => {
    const person = { ...art.lookPalette('dev-1', 0) }
    const problems = [
      ...Object.entries(art.PERSON).flatMap(([n, s]) => art.spriteProblems(`PERSON.${n}`, s, person)),
      ...art.HAIR.flatMap((h, i) => art.spriteProblems(`HAIR.${i}`, art.withHair(art.PERSON.sit, i), person)),
      ...art.spriteProblems('INTERN', art.INTERN, person),
      ...Object.entries(art.ACCESSORY).flatMap(([n, a]) => art.spriteProblems(n, a.art, { ...art.ACCESSORY_PALETTE, s: 1, c: 1, h: 1 })),
      ...(['DESK', 'MONITOR', 'PLANT', 'COFFEE', 'SHELF', 'DOOR'] as const).flatMap(n => art.spriteProblems(n, art[n], art.FURNITURE_PALETTE)),
      ...art.spriteProblems('WINDOW', art.WINDOW, art.WINDOW_PALETTE(false)),
    ]
    expect(problems).toEqual([])
  })
  test('person frames are 8×12 and every look is complete', () => {
    for (const s of Object.values(art.PERSON)) expect([s.length, s[0]!.length]).toEqual([12, 8])
    for (const id of art.LOOK_IDS) expect(Object.keys(art.lookPalette(id, 0)).sort()).toEqual(['C', 'c', 'e', 'h', 'k', 'p', 's'])
  })
  test('same-colour agents in a room never share a style; earlier arrivals keep theirs', () => {
    const seats = Array.from({ length: art.STYLES }, (_, i) => seat(i, 'idle', { character: 'dev-1', joinedAt: NOW + i }))
    const all = styles(seats)
    expect(new Set(all.values()).size).toBe(art.STYLES)
    expect(styles(seats.slice(0, 3))).toEqual(new Map([...all].slice(0, 3)))
  })
  test('unknown character falls back to a look by index', () => {
    expect(art.lookPalette('nope', 1)).toEqual(art.lookPalette('dev-2', 0))
  })
})

describe('pixels', () => {
  test('blit clips at every edge and skips transparent keys', () => {
    const f = frame(4, 4, 0)
    blit(f, ['ab', 'b.'], -1, -1, { a: 1, b: 2 })
    blit(f, ['ab', 'b.'], 3, 3, { a: 1, b: 2 })
    expect([...f.px]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  })
  test('rect clips; text clips to the frame and drops off-frame rows', () => {
    const f = frame(5, 4, 0)
    rect(f, 3, 3, 9, 9, 7)
    expect(f.px[19]).toBe(7)
    expect(f.px[18]).toBe(7)
    text(f, 3, 0, 'hello', 1, 2)
    text(f, -2, 1, 'abcdef', 1, 2)
    text(f, 0, 2, 'gone', 1, 2)
    expect(f.texts.map(t => [t.col, t.row, t.text])).toEqual([[3, 0, 'he'], [0, 1, 'cdef']])
  })
})

describe('encoders', () => {
  test('raster: ▀ with top px as fg and bottom as bg, then text on top', () => {
    const f = frame(2, 4, 0)
    f.px.set([1, 2, 3, 4, 5, 6, 7, 8])
    text(f, 1, 1, 'A', 9, 10)
    expect([...toRasterWords(f)]).toEqual([0x2580, 1, 3, 0x2580, 2, 4, 0x2580, 5, 7, 65, 9, 10])
  })
  test('isCellChar keeps width-1 text and rejects emoji / wide / invisible', () => {
    for (const ch of 'aZ0 ~é…→█') expect(isCellChar(ch.codePointAt(0)!)).toBe(true)
    for (const ch of ['🙂', '漢', '\u200b', '\u0301', '\u1100', '✎', '❗']) expect(isCellChar(ch.codePointAt(0)!)).toBe(false)
  })
  test('raster text drops icons it cannot draw and closes up', () => {
    const f = frame(6, 2, 0)
    text(f, 0, 0, '✎ ab🔍c', 1, 2)
    const words = [...toRasterWords(f)]
    expect([0, 1, 2, 3, 4].map(c => String.fromCodePoint(words[c * 3]!))).toEqual([' ', 'a', 'b', 'c', '▀'])
  })
  test('the desk shows your title, else the automatic one, cut to the desk', () => {
    const L = layout(48, 2)
    const seats = [seat(0, 'typing', { task: 'write tests for the auth controller' }), seat(1, 'idle', { task: 'ignored', title: 'Auth' })]
    const texts = drawOffice(L, seats, assignDesks(['s0', 's1'], L.desks.length), NOW).texts.map(t => t.text)
    expect(texts).toContain('write tests for…')
    expect(texts).toContain('Auth')
  })
  test('raster cells length is columns × rows × 12 bytes', () => {
    const L = layout(80, 5)
    const f = drawOffice(L, [0, 1, 2, 3, 4].map(i => seat(i, ALL[i]!)), assignDesks(['s0', 's1', 's2', 's3', 's4'], L.desks.length), NOW)
    expect(toRasterWords(f).byteLength).toBe(L.w * (L.h / 2) * 12)
  })
  test('svg is deterministic, escapes text, and stays under the 131072 limit', () => {
    const seats = Array.from({ length: 24 }, (_, i) => seat(i, ALL[i % ALL.length]!, { bubble: `<b>&"${i}"` }))
    const L = layout(132, seats.length)
    const desk = assignDesks(seats.map(s => s.id), L.desks.length)
    const a = toSvg(drawOffice(L, seats, desk, NOW), 6)
    expect(a).toBe(toSvg(drawOffice(L, seats, desk, NOW), 6))
    expect(a).toContain('&lt;b&gt;&amp;&quot;')
    expect(a).not.toContain('<b>')
    expect(a.length < 131072).toBe(true)
  })
})

describe('scene', () => {
  test('layout: desks fit, never overlap, sit on whole cells, rows capped', () => {
    for (const cols of [10, 24, 40, 60, 80, 120, 200, 512, 900])
      for (const n of [0, 1, 3, 9, 30, 200]) {
        const L = layout(cols, n)
        expect(L.h % 2).toBe(0)
        expect(L.rows <= MAX_ROWS).toBe(true)
        expect(L.desks.length).toBe(L.cols * L.rows)
        for (const d of L.desks) {
          expect(d.x >= 0 && d.x + CELL_W <= L.w && d.y + CELL_H <= L.h && d.y % 2 === 0).toBe(true)
        }
        const keys = new Set(L.desks.map(d => `${d.x},${d.y}`))
        expect(keys.size).toBe(L.desks.length)
      }
  })
  test('every state draws without throwing, texts stay in bounds', () => {
    const seats = ALL.map((s, i) => seat(i, s, { interns: i % 4, isAway: i === 3 }))
    const L = layout(120, seats.length)
    const f = drawOffice(L, seats, assignDesks(seats.map(s => s.id), L.desks.length), NOW)
    for (const t of f.texts) expect(t.col >= 0 && t.col + [...t.text].length <= L.w && t.row < L.h / 2).toBe(true)
    expect(f.texts.some(t => t.text.includes('• agent-0'))).toBe(true)
    expect(f.texts.some(t => t.text.includes('(away)'))).toBe(true)
  })
  test('subagents play on a mat under the desk: ten shown, the rest as +N', () => {
    expect(layout(80, 3, true).h).toBe(layout(80, 3).h + PLAY_H)
    const L = layout(80, 2, true)
    const f = drawOffice(L, [seat(0, 'delegating', { interns: 13 }), seat(1, 'typing', { interns: 10 })], new Map([['s0', 0], ['s1', 1]]), NOW)
    expect(f.texts.filter(t => t.text.startsWith('+')).map(t => t.text)).toEqual(['+3'])
    expect(hitTest(L, new Map([['s0', 0]]), L.desks[0]!.x + 5, (L.desks[0]!.y + CELL_H + 4) / 2)).toBe('s0')
  })
  test('idle for over a minute snores; seats with no desk are skipped', () => {
    const L = layout(30, 1)
    const f = drawOffice(L, [seat(0, 'idle', { since: NOW - 61_000 }), seat(1, 'typing')], new Map([['s0', 0], ['s1', -1]]), NOW)
    expect(f.texts.map(t => t.text.trim())).toContain('z z z')
    expect(f.texts.some(t => t.text.includes('agent-1'))).toBe(false)
  })
  test('hitTest maps a cell to the seat at that desk', () => {
    const L = layout(80, 3)
    const desk = new Map([['a', 0], ['b', 2]])
    const d2 = L.desks[2]!
    expect(hitTest(L, desk, L.desks[0]!.x + 5, L.desks[0]!.y / 2 + 4)).toBe('a')
    expect(hitTest(L, desk, d2.x + CELL_W - 1, d2.y / 2)).toBe('b')
    expect(hitTest(L, desk, L.desks[1]!.x + 5, L.desks[1]!.y / 2 + 4)).toBe(null)
    expect(hitTest(L, desk, 0, 0)).toBe(null)
  })
})
