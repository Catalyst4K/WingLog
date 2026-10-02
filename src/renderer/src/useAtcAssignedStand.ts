import { useMemo } from 'react'
import type { BeyondAtcTranscriptEntry } from '@shared/ipc'
import { useLiveTopic } from './live/LiveClient'
import { parseTaxiStand } from './taxiRouteParser'

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

/**
 * The arrival stand BeyondATC assigned, live (stand-positions.md, Callum 2026-10-02):
 * BeyondATC normally hands it to GSX itself; when that handoff fails, GSX's gate search is the
 * fallback, and this is what WingLog offers there. Null when BeyondATC hasn't assigned one.
 */
export function useAtcAssignedStand(): string | null {
  const transcript = useLiveTopic('beyondAtcTranscript', NO_TRANSCRIPT)
  return useMemo(() => latestAtcStand(transcript), [transcript])
}
