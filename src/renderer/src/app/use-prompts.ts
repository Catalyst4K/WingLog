/**
 * The two prompts that interrupt the pilot on any page: a BeyondATC clearance that would change the chosen procedures, and an
 * important GSX menu (pushback direction, fuel amount). They read through the LiveClient, so the desktop window and the second
 * screen run the very same code (winglog-backend's docs/plans/lan-popups.md).
 */

import { useEffect, useRef, useState } from 'react'
import type { BeyondAtcState, GsxRemoteMenuState, ProcedureSelection } from '@shared/ipc'
import { gsxPromptState } from '../gsx-remote-importance'
import { useLiveClient } from '../live/LiveClient'
import { runAsync } from '../report-error'
import {
  applyClearance,
  clearanceDiffers,
  readNewInfoBoxes,
  resolveAtcClearance,
  type PendingAtcClearance
} from './atc-clearance'

/**
 * Reads each new set of BeyondATC InfoBoxes for a clearance whose fields differ from the current selection, and holds it for the
 * user's accept or dismiss: overwrite, but ask first, gently. Never ATC's speech (winglog-backend's
 * docs/decisions.md). Re-subscribes whenever the selection changes so a diff is always checked against the live value,
 * the same "just resubscribe, it's cheap" style as procedure-selection.ts's fetch effects.
 *
 * @param selection The current procedure selection.
 * @param setSelection Applies an accepted clearance.
 * @returns The clearance awaiting an answer, and the accept and dismiss handlers.
 */
export function useAtcClearancePrompt(
  selection: ProcedureSelection,
  setSelection: React.Dispatch<React.SetStateAction<ProcedureSelection>>
): { pending: PendingAtcClearance | null; onAccept: () => void; onDismiss: () => void } {
  // Unlike the GSX prompt, no remembered-dismissal key is needed: each new set of InfoBoxes
  // is read once (lastAtcBoxesKey below), not re-offered while it stays up.
  const [pending, setPending] = useState<PendingAtcClearance | null>(null)
  // The last set of BeyondATC InfoBoxes already read: the state is pushed on every BeyondATC
  // message, so this tells a genuinely new set apart from one already considered (and
  // possibly dismissed).
  const lastAtcBoxesKey = useRef('')
  const client = useLiveClient()

  useEffect(() => {
    return client.subscribe('beyondAtcState', (state: BeyondAtcState) => {
      const read = readNewInfoBoxes(lastAtcBoxesKey.current, state, Date.now())
      if (!read) return
      lastAtcBoxesKey.current = read.key
      if (!read.candidate) return
      runAsync(
        'atc clearance offer',
        resolveAtcClearance(read.candidate, selection).then((offer) => {
          if (offer) setPending(offer)
        })
      )
    })
  }, [client, selection])

  // The other screen answered it (the phone pressed Update, or the desktop did): the selection already holds what this one would
  // apply, so there is nothing left to ask, and a stale Update here must not be pressable. Adjusted while rendering, React's
  // pattern for state that follows a prop.
  if (pending && !clearanceDiffers(pending, selection)) setPending(null)

  return {
    pending,
    onAccept: () => {
      if (!pending) return
      setSelection((prev) => applyClearance(prev, pending.fields))
      setPending(null)
    },
    onDismiss: () => setPending(null)
  }
}

/**
 * GSX's live menu, tracked at the top level (not just inside GsxRemoteView) so an "important"
 * one — pushback direction, fuel amount, Callum's explicit call — can interrupt
 * wherever the user currently is, not just when they happen to be on the GSX tab. Everything
 * else GSX might ask stays confined to that tab, unflagged, resolved by GSX's own
 * default/timeout if nobody answers there (winglog-backend's docs/gsx-notes.md).
 *
 * @param onGsxTab Whether the GSX tab is showing, where the menu is answered in place.
 * @returns The menu, whether the global prompt is open, and its dismiss handler.
 */
export function useImportantGsxMenu(onGsxTab: boolean): {
  menu: GsxRemoteMenuState | null
  open: boolean
  onDismiss: () => void
} {
  const client = useLiveClient()
  const [menu, setMenu] = useState<GsxRemoteMenuState | null>(null)
  // Remembers which exact menu the user dismissed without answering, so closing the global
  // prompt doesn't just reopen itself on the next unrelated re-render — only a genuinely
  // different menu (a new signature) triggers it again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    // The menu GSX is showing now, then each change.
    client.get('gsxRemoteMenu').then(
      (current) => current && setMenu(current),
      () => undefined
    )
    return client.subscribe('gsxRemoteMenu', setMenu)
  }, [client])

  const { open, menuKey } = gsxPromptState(menu, onGsxTab, dismissedKey)
  return {
    menu,
    open,
    onDismiss: () => {
      if (menuKey) setDismissedKey(menuKey)
    }
  }
}
