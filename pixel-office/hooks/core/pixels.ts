// A frame: opaque pixels plus text runs laid on whole cells (1 px wide, 2 px tall).

export type TextRun = { col: number; row: number; text: string; fg: number; bg: number }
export type Frame = { w: number; h: number; px: Uint32Array; texts: TextRun[] }

/** A sprite is rows of palette keys; '.' (or a key the palette lacks) is transparent. */
export type Sprite = readonly string[]
export type Palette = Readonly<Record<string, number>>

export function frame(w: number, h: number, fill = 0): Frame {
  return { w, h, px: new Uint32Array(w * h).fill(fill), texts: [] }
}

export function plot(f: Frame, x: number, y: number, color: number): void {
  if (x >= 0 && y >= 0 && x < f.w && y < f.h) f.px[y * f.w + x] = color
}

export function rect(f: Frame, x: number, y: number, w: number, h: number, color: number): void {
  for (let j = Math.max(0, y); j < Math.min(f.h, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(f.w, x + w); i++) f.px[j * f.w + i] = color
}

export function blit(f: Frame, s: Sprite, x: number, y: number, pal: Palette, dim = 1): void {
  s.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = pal[row[i]!]
      if (c !== undefined) plot(f, x + i, y + j, dim === 1 ? c : shade(c, dim))
    }
  })
}

/** Text on cell (col, row); cut at the frame's right edge, dropped off-frame. */
export function text(f: Frame, col: number, row: number, t: string, fg: number, bg: number): void {
  if (row < 0 || row >= f.h / 2 || col >= f.w) return
  let chars = [...t]
  if (col < 0) (chars = chars.slice(-col)), (col = 0)
  chars = chars.slice(0, f.w - col)
  if (chars.length) f.texts.push({ col, row, text: chars.join(''), fg, bg })
}

export function shade(c: number, k: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k))
  const b = Math.min(255, Math.round((c & 255) * k))
  return (r << 16) | (g << 8) | b
}
