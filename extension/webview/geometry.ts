// Fitting the pixel office into the webview: logical width, integer scale, pointer → cell.

/** Logical office width (pixels) and integer scale for a container `px` wide. */
export function fit(px: number, mini: boolean): { width: number; scale: number } {
  const target = mini ? 4 : 7 // screen pixels per office pixel we aim for
  const width = Math.max(46, Math.min(140, Math.floor(px / target)))
  const scale = Math.max(2, Math.floor(px / width))
  return { width, scale }
}

/** The text cell (1 px wide, 2 px tall) under a pointer at (x, y) CSS pixels. */
export function cellAt(x: number, y: number, scale: number): { col: number; row: number } {
  return { col: Math.floor(x / scale), row: Math.floor(y / (2 * scale)) }
}

/** Centre of a desk's character, in CSS pixels: where collision lines start and end. */
export function deskCentre(desk: { x: number; y: number }, scale: number): { x: number; y: number } {
  return { x: (desk.x + 14) * scale, y: (desk.y + 12) * scale }
}
