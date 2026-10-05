import { describe, expect, it, vi } from 'vitest'
import { TaxiBoxCheck } from './taxi-box-check'

// Real VHHH boxes and speech, 2026-10-05: "taxi to holding point J1, runway 07R, via B, B, V, H, J".
const VHHH_BOXES = [
  { title: 'Taxi to Runway', info: '07R' },
  ...['B', 'B', 'V', 'H', 'J'].map((info, i) => ({ title: `Taxi Via ${i + 1}`, info })),
  { title: 'Hold Position', info: 'J1' }
]
const VHHH_SPEECH = 'Hongkong Shuttle 250, taxi to holding point J1, runway 07R, via B, B, V, H, J.'

describe('TaxiBoxCheck', () => {
  it('stays quiet when the boxes and the speech agree, in either order', () => {
    const report = vi.fn()
    const check = new TaxiBoxCheck(report)
    check.onInfoBoxes(VHHH_BOXES, 1000)
    check.onAtcLine(VHHH_SPEECH, 2000)
    const reverse = new TaxiBoxCheck(report)
    reverse.onAtcLine(VHHH_SPEECH, 1000)
    reverse.onInfoBoxes(VHHH_BOXES, 2000)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports a different route once, naming both', () => {
    const report = vi.fn()
    const check = new TaxiBoxCheck(report)
    check.onInfoBoxes(VHHH_BOXES, 1000)
    check.onAtcLine('Hongkong Shuttle 250, taxi to holding point J1, runway 07R, via B, V, H, J.', 2000)
    check.onInfoBoxes([...VHHH_BOXES], 3000)
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('[beyondatc] taxi route mismatch: InfoBoxes B, B, V, H, J; speech B, V, H, J')
  })

  it('ignores lines that are not taxi clearances, boxes without a route, and pairs far apart in time', () => {
    const report = vi.fn()
    const check = new TaxiBoxCheck(report)
    check.onInfoBoxes([{ title: 'Tower Frequency', info: '118.4' }], 0)
    check.onAtcLine('Hongkong Shuttle 250, contact tower 118.4.', 0)
    check.onInfoBoxes(VHHH_BOXES, 0)
    check.onAtcLine('Hongkong Shuttle 250, taxi to Stand 12 via B, C4.', 10 * 60_000)
    expect(report).not.toHaveBeenCalled()
  })
})
