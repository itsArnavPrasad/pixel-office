// A frame as the terminal's Raster cells, or as an SVG document.
import type { Frame } from './pixels'

// The environment has the TC39 base64 method; es2023's lib does not type it yet.
declare global {
  interface Uint8Array {
    toBase64(): string
  }
}

const UPPER_HALF = 0x2580

/**
 * Raster cells take one printable width-1 BMP code point; anything wider or
 * invisible (emoji, CJK, combining marks, zero-width) is dropped from text.
 */
export function isCellChar(cp: number): boolean {
  const ok =
    (cp >= 0x20 && cp < 0x7f) ||
    (cp >= 0xa0 && cp < 0x300) ||
    (cp >= 0x370 && cp < 0x1100) ||
    (cp >= 0x2010 && cp <= 0x2027) ||
    (cp >= 0x2030 && cp < 0x2060) ||
    (cp >= 0x2190 && cp < 0x2300) ||
    (cp >= 0x2500 && cp < 0x2600)
  return ok
}

/** columns = w, rows = h / 2: each cell is ▀ with the top pixel as fg, bottom as bg. */
export function toRasterWords(f: Frame): Uint32Array {
  const rows = f.h >> 1
  const out = new Uint32Array(f.w * rows * 3)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < f.w; c++) {
      const i = (r * f.w + c) * 3
      out[i] = UPPER_HALF
      out[i + 1] = f.px[2 * r * f.w + c]!
      out[i + 2] = f.px[(2 * r + 1) * f.w + c]!
    }
  for (const t of f.texts) {
    let c = t.col
    // a dropped glyph (an emoji icon) takes no cell; the run closes up
    for (const ch of [...t.text.replace(/\uFE0F/g, '')].filter(ch => isCellChar(ch.codePointAt(0)!))) {
      if (c >= f.w) break
      const i = (t.row * f.w + c) * 3
      out[i] = ch.codePointAt(0)!
      out[i + 1] = t.fg
      out[i + 2] = t.bg
      c++
    }
  }
  return out
}

export function toRasterCells(f: Frame): string {
  return new Uint8Array(toRasterWords(f).buffer).toBase64()
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One <path> per colour of horizontal runs, then text runs on their plates. */
export function toSvg(f: Frame, scale: number): string {
  const runs = new Map<number, string[]>()
  for (let y = 0; y < f.h; y++) {
    let x = 0
    while (x < f.w) {
      const c = f.px[y * f.w + x]!
      let n = 1
      while (x + n < f.w && f.px[y * f.w + x + n] === c) n++
      let list = runs.get(c)
      if (!list) runs.set(c, (list = []))
      list.push(`M${x} ${y}h${n}v1H${x}z`)
      x += n
    }
  }
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" width="${f.w * scale}" height="${f.h * scale}" shape-rendering="crispEdges">`,
  ]
  for (const [c, d] of runs) parts.push(`<path fill="${hex(c)}" d="${d.join('')}"/>`)
  if (f.texts.length) {
    parts.push('<g xml:space="preserve" font-family="ui-monospace,Menlo,monospace" font-size="1.66" shape-rendering="auto">')
    for (const t of f.texts) {
      const len = [...t.text].length
      parts.push(
        `<rect x="${t.col}" y="${t.row * 2}" width="${len}" height="2" fill="${hex(t.bg)}"/>`,
        `<text x="${t.col}" y="${t.row * 2 + 1.5}" fill="${hex(t.fg)}" textLength="${len}" lengthAdjust="spacingAndGlyphs">${esc(t.text)}</text>`,
      )
    }
    parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('')
}
