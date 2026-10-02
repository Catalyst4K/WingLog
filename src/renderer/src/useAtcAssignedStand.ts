import { useEffect, useState } from 'react'
import type { BeyondAtcTranscriptEntry } from '@shared/ipc'
import { parseTaxiStand } from './taxiRouteParser'

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
  const [stand, setStand] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const ingest = (transcript: BeyondAtcTranscriptEntry[]): void => {
      if (live) setStand(latestAtcStand(transcript))
    }
    window.winglog.beyondAtcGetTranscript().then(ingest, () => undefined)
    const unsubscribe = window.winglog.onBeyondAtcTranscript(ingest)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return stand
}
