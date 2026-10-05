import { describe, expect, it } from 'vitest'
import { infoBoxStand, latestAtcStand } from './useAtcAssignedStand'

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

describe('infoBoxStand', () => {
  it("reads the gate from BeyondATC's real Taxi to Gate box (EGLL, flight 229, 2026-10-05)", () => {
    // Set at 12:17 with the first half of a split clearance; ATC only said "Stand 411" at 12:24.
    expect(
      infoBoxStand([
        { title: 'Taxi to Gate', info: 'Gate 411' },
        { title: 'Taxi Via 1', info: 'E' },
        { title: 'Taxi Via 2', info: 'LINK 36' },
        { title: 'ATIS Current', info: 'C' }
      ])
    ).toBe('411')
  })

  it('reads a stand box the same way, with or without the word in front', () => {
    expect(infoBoxStand([{ title: 'Taxi to Stand', info: 'Stand N32' }])).toBe('N32')
    expect(infoBoxStand([{ title: 'Taxi to Gate', info: '76A' }])).toBe('76A')
  })

  it('is null with no gate box, or one it cannot read', () => {
    expect(infoBoxStand([{ title: 'ATIS Current', info: 'C' }])).toBeNull()
    expect(infoBoxStand([{ title: 'Taxi to Gate', info: 'Gate to be assigned' }])).toBeNull()
    expect(infoBoxStand([])).toBeNull()
  })
})
