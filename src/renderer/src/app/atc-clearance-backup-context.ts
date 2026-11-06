import { createContext } from 'react'
import type { ProcedureSelection } from '@shared/ipc'
import type { PendingAtcClearance } from './atc-clearance'

/** The clearance waiting after its pop-up closed, and what answers it. */
export interface AtcClearanceBackup {
  clearance: PendingAtcClearance
  selection: ProcedureSelection
  onAccept: () => void
  onDismiss: () => void
}

/** Provided by the app (null while nothing is waiting); read by the BeyondATC page. A page rendered without it (a test, the second screen) shows no backup. */
export const AtcClearanceBackupContext = createContext<AtcClearanceBackup | null>(null)
