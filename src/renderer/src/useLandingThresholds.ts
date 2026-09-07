import { useEffect, useState } from 'react'
import type { LandingThresholds } from '@shared/ipc'

// Mirrors settings-repo.ts's own defaults — shown immediately, before the IPC round-trip
// resolves, rather than flashing "none" on every severity badge for a moment.
const DEFAULT_THRESHOLDS: LandingThresholds = { firmFpm: 480, hardFpm: 600 }

/** Shared by Fleet and Logbook's landing panes so both classify against the same,
 *  currently-configured thresholds (docs/decisions.md, landing-analysis entry). */
export function useLandingThresholds(): LandingThresholds {
  const [thresholds, setThresholds] = useState<LandingThresholds>(DEFAULT_THRESHOLDS)
  useEffect(() => {
    window.winglog.settingsGetLandingThresholds().then(setThresholds)
  }, [])
  return thresholds
}
