import { describe, expect, it } from 'vitest'
import { latestAtcStand } from './useAtcAssignedStand'

describe('latestAtcStand', () => {
  it("takes the stand from ATC's most recent stand clearance, ignoring other aircraft and readbacks", () => {
    expect(
      latestAtcStand([
        { speaker: 'atc', text: 'Cathay 168 Heavy, taxi to Stand N30 via J, H6.', ts: 1 },
        { speaker: 'atc', text: 'Cathay 168 Heavy, taxi to Stand N32 via J, H6, H, V, B.', ts: 2 },
        { speaker: 'player', text: 'Taxi to Stand N32 via J, H6, H, V, B, Cathay 168 Heavy.', ts: 3 },
        { speaker: 'atcTraffic', text: 'Velocity 175, taxi to Stand 76A via A4, A.', ts: 4 }
      ])
    ).toBe('N32')
  })

  it('is null before any stand is assigned', () => {
    expect(latestAtcStand([{ speaker: 'atc', text: 'Cathay 168 Heavy, contact ground 122.6.', ts: 1 }])).toBeNull()
    expect(latestAtcStand([])).toBeNull()
  })
})
