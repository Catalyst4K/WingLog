import { useMemo } from 'react'
import type { BeyondAtcInfoBox, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { assignedGate, parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { useLiveTopic } from './live/LiveClient'
import { parseTaxiStand } from '@shared/taxi-route-parser'

const NO_TRANSCRIPT: BeyondAtcTranscriptEntry[] = []

/** The stand in BeyondATC's most recent "taxi to Stand N32 …" (ATC's own lines only). */
export function latestAtcStand(transcript: BeyondAtcTranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]!
    if (entry.speaker !== 'atc') continue
    const stand = parseTaxiStand(entry.text)
    if (stand) return stand
  }
  return null
}

/** The gate in BeyondATC's InfoBoxes: "Taxi to Gate" / "Gate 411" → '411' (real, EGLL
 *  2026-10-05), else the earlier "Expect Gate" (ZJSY, 2026-10-05: 1.5 min before the taxi
 *  call). Null when there's no such box. */
export function infoBoxStand(boxes: BeyondAtcInfoBox[]): string | null {
  return assignedGate(parseAtcTaxiFacts(boxes))
}

/**
 * The arrival stand BeyondATC assigned, live (stand-positions.md, Callum 2026-10-02):
 * BeyondATC normally hands it to GSX itself; when that handoff fails, GSX's gate search is the
 * fallback, and this is what WingLog offers there.
 *
 * BeyondATC's "Taxi to Gate" or "Expect Gate" info box comes first. It's set as soon as
 * BeyondATC assigns the gate, which can be well before ATC says it: EGLL, flight 229,
 * 2026-10-05, gate 411 was assigned with the first half of a split clearance (12:17) but only
 * spoken in the second (12:24), and BeyondATC's own GSX handoff failed in between. The spoken
 * stand is the fallback. Null when BeyondATC hasn't assigned one.
 */
export function useAtcAssignedStand(): string | null {
  const transcript = useLiveTopic('beyondAtcTranscript', NO_TRANSCRIPT)
  const state = useLiveTopic('beyondAtcState', EMPTY_BEYONDATC_STATE)
  return useMemo(() => infoBoxStand(state.infoBoxes) ?? latestAtcStand(transcript), [state.infoBoxes, transcript])
}
