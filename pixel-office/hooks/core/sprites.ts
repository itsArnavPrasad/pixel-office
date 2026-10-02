// Built-in art. Every sprite is string art over a palette, so packs can be plain JSON.
import type { Palette, Sprite } from './pixels'

// ── people (8 × 12) ──────────────────────────────────────────────
// h hair · s skin · e eye · c shirt · C shirt shade · p pants · k shoes
export const PERSON = {
  sit: [
    '..hhhh..',
    '.hhhhhh.',
    '.hssssh.',
    '.sesses.',
    '.ssssss.',
    '...ss...',
    '.cccccc.',
    'cccccccc',
    'sccCCccs',
    'sccccccs',
    '.pppppp.',
    '.pp..pp.',
  ],
  blink: [
    '..hhhh..',
    '.hhhhhh.',
    '.hssssh.',
    '.ssssss.',
    '.ssssss.',
    '...ss...',
    '.cccccc.',
    'cccccccc',
    'sccCCccs',
    'sccccccs',
    '.pppppp.',
    '.pp..pp.',
  ],
  walk1: [
    '..hhhh..',
    '.hhhhhh.',
    '.hssssh.',
    '.sesses.',
    '.ssssss.',
    '...ss...',
    '.cccccc.',
    'scccccc.',
    'sccCCccs',
    '.ccccccs',
    '.pp..pp.',
    'kk....kk',
  ],
  walk2: [
    '..hhhh..',
    '.hhhhhh.',
    '.hssssh.',
    '.sesses.',
    '.ssssss.',
    '...ss...',
    '.cccccc.',
    '.ccccccs',
    'sccCCccs',
    'scccccc.',
    '..pppp..',
    '..kkkk..',
  ],
} satisfies Record<string, Sprite>

export const INTERN: Sprite = ['.hh.', 'hssh', '.ss.', 'cccc', 'cccc', '.pp.']

// ── accessories, drawn relative to the person's top-left ─────────
export const ACCESSORY = {
  handUp: { at: [7, -2], art: ['s', 's', 's', 's', 's', 's', 's', 's', 'c', 'c'] },
  armsUpL: { at: [-1, -1], art: ['s', 's', 's', 's', 's', 's', 's', 's', 'c'] },
  armsUpR: { at: [8, -1], art: ['s', 's', 's', 's', 's', 's', 's', 's', 'c'] },
  alert: { at: [9, -2], art: ['y', 'y', 'y', '.', 'y'] },
  sweat: { at: [7, 1], art: ['b', 'b'] },
  book1: { at: [1, 8], art: ['rrwwrr', 'rrwwrr'] },
  book2: { at: [1, 8], art: ['rrrwwr', 'rrrwwr'] },
  paper: { at: [1, 9], art: ['wwwww'] },
  pencil1: { at: [2, 8], art: ['y'] },
  pencil2: { at: [4, 8], art: ['y'] },
  hands1: { at: [0, 9], art: ['s......s'] },
  hands2: { at: [0, 9], art: ['.s....s.'] },
  dot: { at: [0, 0], art: ['w'] },
} satisfies Record<string, { at: readonly [number, number]; art: Sprite }>

export const ACCESSORY_PALETTE: Palette = {
  y: 0xffd23f, b: 0x5ab8ff, r: 0xd94848, w: 0xffffff,
}

// ── furniture ────────────────────────────────────────────────────
export const DESK: Sprite = [
  'tttttttttttttttttt',
  'ffffffffffffffffff',
  'fFFFFFFFFFFFFFFFFf',
  'fFFFFFFFFFFFFFFFFf',
  'l................l',
  'l................l',
]
export const MONITOR: Sprite = ['mmmmmm', 'mSSSSm', 'mSSSSm', 'mSSSSm', 'mmmmmm', '..mm..']
export const PLANT: Sprite = ['.g.G.', 'gGgGg', '.gGg.', 'GgGgG', '.ooo.', '.ooo.', '..o..']
export const COFFEE: Sprite = ['kkkkk', 'kRRRk', 'kkkkk', 'k.w.k', 'kkkkk']
export const SHELF: Sprite = ['bbbbbbbb', 'b1234123', 'bbbbbbbb', 'b3412341', 'bbbbbbbb']
export const WINDOW: Sprite = [
  'wwwwwwwwww',
  'wGGGGwHGGw',
  'wGGGGwGGGw',
  'wwwwwwwwww',
  'wGGHGwGGGw',
  'wGGGGwGGGw',
  'wwwwwwwwww',
]
export const DOOR: Sprite = ['dddddd', 'dDDDDd', 'dDDDDd', 'dDDDDd', 'dDDDyd', 'dDDDDd', 'dDDDDd', 'dDDDDd']

// ── looks: palette swaps per character id ───────────────────────
type Look = { h: number; s: number; c: number; C: number; p: number; k: number }
export const LOOKS: Readonly<Record<string, Look>> = {
  'dev-1': { h: 0x3b2417, s: 0xf1c27d, c: 0x4a7bd1, C: 0x3a62a8, p: 0x2d2d3a, k: 0x1a1a1a },
  'dev-2': { h: 0xe8c547, s: 0xffdbac, c: 0xd9534f, C: 0xb03f3c, p: 0x34495e, k: 0x222222 },
  'dev-3': { h: 0x111111, s: 0x8d5524, c: 0x2ecc71, C: 0x25a25a, p: 0x2c3e50, k: 0x111111 },
  'dev-4': { h: 0xb5651d, s: 0xe0ac69, c: 0x9b59b6, C: 0x7d4592, p: 0x3d3d3d, k: 0x1a1a1a },
  'dev-5': { h: 0xc0c0c0, s: 0xffe0bd, c: 0xf39c12, C: 0xc87f0a, p: 0x1f3a5f, k: 0x202020 },
  'dev-6': { h: 0xd1495b, s: 0xc68642, c: 0x1abc9c, C: 0x159a80, p: 0x2b2b2b, k: 0x111111 },
  'dev-7': { h: 0x2c1b10, s: 0xffcd94, c: 0xecf0f1, C: 0xbdc3c7, p: 0x5d4037, k: 0x3e2723 },
  'dev-8': { h: 0x6a3d9a, s: 0xa1665e, c: 0xe84393, C: 0xc2367a, p: 0x2d3436, k: 0x111111 },
}
export const LOOK_IDS = Object.keys(LOOKS)

export function lookPalette(character: string, fallbackIndex: number): Palette {
  const look = LOOKS[character] ?? LOOKS[LOOK_IDS[fallbackIndex % LOOK_IDS.length]!]!
  return { ...look, e: 0x1a1a1a }
}

export const FURNITURE_PALETTE: Palette = {
  t: 0xa0703f, f: 0x8b5a2b, F: 0x7a4d24, l: 0x4a2e15,
  m: 0x2b2b2b, S: 0x1e2a35,
  g: 0x3f9b4a, G: 0x2f7a38, o: 0xb5543c,
  k: 0x3a3a3a, R: 0xc0392b, w: 0xdddddd,
  b: 0x6b4a2b, 1: 0xd94848, 2: 0x4a90d9, 3: 0x3fae5a, 4: 0xe0b23f,
  d: 0x5a3a22, D: 0x7a5232, y: 0xffd23f,
}
export const WINDOW_PALETTE = (isNight: boolean): Palette => ({
  w: 0x6b5a45, G: isNight ? 0x1b2a4a : 0x8fd3ff, H: isNight ? 0xfff3b0 : 0xd5f0ff,
})

/** Problems with a sprite against its palette: ragged rows or unknown keys. */
export function spriteProblems(name: string, s: Sprite, pal: Palette): string[] {
  const out: string[] = []
  const w = s[0]?.length ?? 0
  s.forEach((row, j) => {
    if (row.length !== w) out.push(`${name}: row ${j} is ${row.length} wide, expected ${w}`)
    for (const ch of row) if (ch !== '.' && pal[ch] === undefined) out.push(`${name}: row ${j} has unknown key '${ch}'`)
  })
  return out
}
