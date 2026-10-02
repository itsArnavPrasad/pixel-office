import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assignDesks } from '../../pixel-office/hooks/core/roster'
import { hitTest, layout } from '../../pixel-office/hooks/core/scene'
import { cellAt, deskCentre, fit } from '../webview/geometry'

test('fit: integer scale, bounded logical width, never wider than the container', () => {
  for (const [px, mini] of [[300, true], [320, true], [600, false], [980, false], [2400, false], [120, true]] as const) {
    const { width, scale } = fit(px, mini)
    assert.ok(Number.isInteger(scale) && scale >= 2)
    assert.ok(width >= 46 && width <= 140)
    if (px >= 92) assert.ok(width * scale <= px, `${px}: ${width}×${scale}`)
  }
})

test('a click on a character lands on its seat at any scale', () => {
  for (const scale of [2, 4, 7]) {
    const L = layout(140, 6)
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const desk = assignDesks(ids, L.desks.length)
    for (const id of ids) {
      const d = L.desks[desk.get(id)!]!
      const p = deskCentre(d, scale)
      const { col, row } = cellAt(p.x, p.y, scale)
      assert.equal(hitTest(L, desk, col, row), id, `scale ${scale} id ${id}`)
    }
  }
})
