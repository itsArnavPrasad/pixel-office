// The office: layout from the room's width, then one frame for a moment in time.
import { HOLD_MS } from './agent'
import { blit, frame, plot, rect, shade, text, type Frame } from './pixels'
import type { Seat } from './roster'
import { hash } from './roster'
import {
  ACCESSORY, ACCESSORY_PALETTE, COFFEE, DESK, DOOR, FURNITURE_PALETTE, INTERN, MONITOR, PERSON,
  PLANT, SHELF, WINDOW, WINDOW_PALETTE, lookPalette,
} from './sprites'
import { truncate, wrap } from './text'

export const CELL_W = 22
export const CELL_H = 22
export const WALL_H = 12
export const MAX_ROWS = 4
export const IDLE_ZZZ_MS = 60_000
const BUBBLE_W = CELL_W - 2

export type Layout = { w: number; h: number; cols: number; rows: number; desks: { x: number; y: number }[] }

/** One pixel per column; desk rows grow with the head count, up to MAX_ROWS. */
export function layout(columns: number, count: number): Layout {
  const w = Math.max(CELL_W + 2, Math.min(Math.floor(columns), 512))
  const cols = Math.max(1, Math.floor((w - 2) / CELL_W))
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil(count / cols)))
  const ox = Math.floor((w - cols * CELL_W) / 2)
  const desks: Layout['desks'] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) desks.push({ x: ox + c * CELL_W, y: WALL_H + r * CELL_H })
  return { w, h: WALL_H + rows * CELL_H + 2, cols, rows, desks }
}

export const DOOR_AT = { x: 3, y: WALL_H - DOOR.length }

export type Theme = {
  wall: number; trim: number; floorA: number; floorB: number
  bubble: number; bubbleText: number; alert: number; plate: number; plateText: number
  isNight: boolean
}

export const DEFAULT_THEME: Theme = {
  wall: 0x3b3552, trim: 0x2a2540, floorA: 0xc8a77a, floorB: 0xbf9d70,
  bubble: 0xffffff, bubbleText: 0x1a1a1a, alert: 0xffe08a, plate: 0x2a2540, plateText: 0xf0f0f0,
  isNight: false,
}

const SCREEN: Partial<Record<Seat['state'], number[]>> = {
  typing: [0x39d353, 0x1e2a35], working: [0x39d353, 0x1e2a35], thinking: [0x2f5d7c, 0x1e2a35],
  browsing: [0x4aa3ff, 0x2f6fb5], reading: [0xe8e8e8, 0xb8b8b8], writing: [0xe8e8e8, 0x39d353],
  delegating: [0xb48cff, 0x1e2a35], 'needs-you': [0xffd23f, 0x1e2a35], stressed: [0xd94848, 0x1e2a35],
  done: [0x39d353, 0x39d353],
}

/** Draws the office for `now`; `seats` already know their desk (`desk` map, -1 = none). */
export function drawOffice(L: Layout, seats: Seat[], desk: Map<string, number>, now: number, theme = DEFAULT_THEME): Frame {
  const f = frame(L.w, L.h, theme.floorA)
  drawRoom(f, L, theme)
  const tick = Math.floor(now / 250) % 2
  const walkers: (() => void)[] = []

  for (const s of seats) {
    const d = desk.get(s.id) ?? -1
    const at = L.desks[d]
    if (!at) continue
    const pal = lookPalette(s.character, hash(s.id))
    const dim = s.isAway ? 0.45 : 1
    const cx = at.x + 10
    const cy = at.y + 6
    const walking = s.state === 'arriving' || s.state === 'leaving'

    if (!walking) {
      const blinks = (now + (hash(s.id) % 3000)) % 3000 < 160
      blit(f, blinks ? PERSON.blink : PERSON.sit, cx, cy, pal, dim)
      if (s.state === 'needs-you') acc(f, 'handUp', cx, cy, pal, dim)
      if (s.state === 'done') acc(f, 'armsUpL', cx, cy, pal, dim), acc(f, 'armsUpR', cx, cy, pal, dim)
      if (s.state === 'needs-you' && tick === 0) acc(f, 'alert', cx, cy, pal, dim)
      if (s.state === 'stressed') acc(f, 'sweat', cx, cy + (Math.floor(now / 200) % 3), pal, dim)
      if (s.state === 'thinking') for (let i = 0; i <= Math.floor(now / 300) % 3; i++) plot(f, cx + 2 + i * 2, at.y + 4, 0xffffff)
    }

    blit(f, DESK, at.x + 2, at.y + 14, FURNITURE_PALETTE, dim)
    blit(f, MONITOR, at.x + 3, at.y + 8, FURNITURE_PALETTE, dim)
    const screen = SCREEN[s.state]
    if (screen && !s.isAway) {
      // three lines of "code" whose lengths scroll with the clock
      const scroll = Math.floor(now / 250) + hash(s.id)
      for (let j = 0; j < 3; j++) {
        const len = 1 + ((scroll + j) * 7) % 4
        for (let i = 0; i < 4; i++) plot(f, at.x + 4 + i, at.y + 9 + j, screen[i < len ? 0 : 1]!)
      }
    }

    if (!walking) {
      if (s.state === 'typing' || s.state === 'working') acc(f, tick ? 'hands1' : 'hands2', cx, cy, pal, dim)
      if (s.state === 'reading') acc(f, tick ? 'book1' : 'book2', cx, cy, pal, dim)
      if (s.state === 'writing') acc(f, 'paper', cx, cy, pal, dim), acc(f, tick ? 'pencil1' : 'pencil2', cx, cy, pal, dim)
    }

    for (let i = 0; i < Math.min(3, s.interns); i++) blit(f, INTERN, at.x + 3 + i * 5, at.y + 16 - ((tick + i) % 2), pal, dim)

    if (walking) {
      walkers.push(() => {
        const p = Math.max(0, Math.min(1, (now - s.since) / HOLD_MS))
        const k = s.state === 'arriving' ? p : 1 - p
        const x = Math.round(DOOR_AT.x + (cx - DOOR_AT.x) * k)
        const y = Math.round(WALL_H - 4 + (cy - (WALL_H - 4)) * k)
        blit(f, tick ? PERSON.walk1 : PERSON.walk2, x, y, pal, dim)
      })
    }

    drawBubble(f, s, at, now, theme)
    const label = truncate(`${s.isMe ? '• ' : ''}${s.name}`, BUBBLE_W)
    const lcol = at.x + 1 + Math.floor((BUBBLE_W - [...label].length) / 2)
    text(f, lcol, at.y / 2 + 10, label, s.isAway ? 0x9a9a9a : theme.plateText, theme.plate)
  }
  walkers.forEach(w => w())
  return f
}

function acc(f: Frame, name: keyof typeof ACCESSORY, cx: number, cy: number, pal: Record<string, number>, dim: number) {
  const a = ACCESSORY[name]
  blit(f, a.art, cx + a.at[0], cy + a.at[1], { ...ACCESSORY_PALETTE, s: pal.s!, c: pal.c! }, dim)
}

function drawBubble(f: Frame, s: Seat, at: { x: number; y: number }, now: number, theme: Theme) {
  let words = s.bubble
  let bg = theme.bubble
  let fg = theme.bubbleText
  if (s.isAway) (words = '(away)'), (bg = 0x55556a), (fg = 0xdddddd)
  else if (s.state === 'needs-you') bg = theme.alert
  else if (s.state === 'idle' && now - s.since > IDLE_ZZZ_MS) (words = 'z z z'), (bg = theme.wall), (fg = 0xcfd6ff)
  if (!words) return
  const lines = wrap(words, BUBBLE_W)
  const shown = lines.length > 2 ? [lines[0]!, truncate(lines.slice(1).join(' '), BUBBLE_W)] : lines
  shown.forEach((line, i) => text(f, at.x + 1, at.y / 2 + i, ` ${line} `.slice(0, BUBBLE_W + 1), fg, bg))
}

function drawRoom(f: Frame, L: Layout, t: Theme) {
  for (let y = WALL_H; y < L.h; y++)
    for (let x = 0; x < L.w; x++) if (((x >> 2) + (y >> 2)) % 2) f.px[y * L.w + x] = t.floorB
  rect(f, 0, 0, L.w, WALL_H, t.wall)
  rect(f, 0, WALL_H - 1, L.w, 1, t.trim)
  blit(f, DOOR, DOOR_AT.x, DOOR_AT.y, FURNITURE_PALETTE)
  const win = WINDOW_PALETTE(t.isNight)
  for (let x = 14; x + 10 <= L.w - 30; x += 30) blit(f, WINDOW, x, 2, win)
  if (L.w >= 60) blit(f, SHELF, L.w - 20, 6, FURNITURE_PALETTE), blit(f, COFFEE, L.w - 28, WALL_H - 5, FURNITURE_PALETTE)
  blit(f, PLANT, L.w - 10, WALL_H - 7, FURNITURE_PALETTE)
  if (t.isNight) for (let x = 0; x < L.w; x++) for (let y = 0; y < L.h; y++) f.px[y * L.w + x] = shade(f.px[y * L.w + x]!, 0.8)
}

/** The seat id under a cell, or null: what a click at (col, row) means. */
export function hitTest(L: Layout, desk: Map<string, number>, col: number, row: number): string | null {
  const x = col
  const y = row * 2
  const d = L.desks.findIndex(at => x >= at.x && x < at.x + CELL_W && y >= at.y && y < at.y + CELL_H)
  if (d < 0) return null
  for (const [id, n] of desk) if (n === d) return id
  return null
}
