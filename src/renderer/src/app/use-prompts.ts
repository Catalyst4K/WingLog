/**
 * The two prompts that interrupt the pilot on any page: a BeyondATC clearance that would change the chosen procedures, and an
 * important GSX menu (pushback direction, fuel amount). They read through the LiveClient, so the desktop window and the second
 * screen run the very same code (winglog-backend's docs/plans/lan-popups.md).
 */

import { useEffect, useRef, useState } from 'react'
import type { BeyondAtcState, GsxRemoteMenuState, ProcedureSelection } from '@shared/ipc'
import { gsxPromptState } from '../gsx-remote-importance'
import { useLiveClient } from '../live/LiveClient'
import { useBeyondAtcHidden } from '../live/use-online-status'
import { logInfo, runAsync } from '../report-error'
import { applyClearance } from '@shared/procedure-selection'
import { parseAtcBoxClearance } from '@shared/atc-info-boxes'
import {
  clearanceDiffers,
  describeClearance,
  describeSelection,
  explainAtcClearance,
  readNewInfoBoxes,
  type PendingAtcClearance
} from './atc-clearance'

/**
 * Writes one line about the clearance prompt to main.log (`[atc-prompt] ...`), so a flight where nobody saw a prompt can say what it did.
 * Only box sets that carry a clearance are logged. On the phone's page this does nothing: it has no way to log to the PC.
 *
 * @param message What happened.
 */
function logPrompt(message: string): void {
  logInfo('atc-prompt', message)
}

/** How long the procedure-update pop-up waits for an answer before it gives way to the line on the BeyondATC page (D5). */
export const ATC_CLEARANCE_POPUP_MS = 60_000

/**
 * Reads each new set of BeyondATC InfoBoxes for a clearance whose fields differ from the current selection, and holds it for the
 * user's accept or dismiss: overwrite, but ask first, gently. Never ATC's speech (winglog-backend's
 * docs/decisions.md). Re-subscribes whenever the selection changes so a diff is always checked against the live value,
 * the same "just resubscribe, it's cheap" style as procedure-selection.ts's fetch effects.
 *
 * @param selection The current procedure selection.
 * @param setSelection Applies an accepted clearance.
 * @param popupMs How long the pop-up stays open unanswered before the question moves to the BeyondATC page, or null to keep it open
 *   (the second screen has no BeyondATC page).
 * @returns The clearance awaiting an answer, whether its pop-up is open or it has moved to the BeyondATC page, and the accept and
 *   dismiss handlers.
 */
export function useAtcClearancePrompt(
  selection: ProcedureSelection,
  setSelection: React.Dispatch<React.SetStateAction<ProcedureSelection>>,
  popupMs: number | null = null
): {
  pending: PendingAtcClearance | null
  popupOpen: boolean
  onAccept: () => void
  onDismiss: () => void
} {
  // Unlike the GSX prompt, no remembered-dismissal key is needed: each new set of InfoBoxes
  // is read once (lastAtcBoxesKey below), not re-offered while it stays up.
  const [pending, setPending] = useState<PendingAtcClearance | null>(null)
  // The clearance whose pop-up has timed out: it is waiting on the BeyondATC page. Keyed by the clearance itself, so a newer one
  // (a new object) gets its own pop-up without anything to reset.
  const [movedOn, setMovedOn] = useState<PendingAtcClearance | null>(null)
  // The last set of BeyondATC InfoBoxes already read: the state is pushed on every BeyondATC
  // message, so this tells a genuinely new set apart from one already considered (and
  // possibly dismissed).
  const lastAtcBoxesKey = useRef('')
  // The sets of boxes already logged as "not offered" for being online or read before, so each is said once however often BeyondATC repeats it.
  const loggedSkipKey = useRef('')
  // The clearance the user answered, and the one shown last render, so a clearance that goes away unanswered can be logged.
  const answered = useRef<PendingAtcClearance | null>(null)
  const previous = useRef<PendingAtcClearance | null>(null)
  const client = useLiveClient()
  // Online, the network's controllers are the only voice: no clearance is offered, and one already offered is withdrawn.
  const hidden = useBeyondAtcHidden()

  useEffect(() => {
    return client.subscribe('beyondAtcState', (state: BeyondAtcState) => {
      if (hidden) {
        logSkipped(state.infoBoxes, 'online, BeyondATC is hidden', loggedSkipKey)
        return
      }
      const read = readNewInfoBoxes(lastAtcBoxesKey.current, state, Date.now())
      if (!read) {
        logSkipped(state.infoBoxes, 'this set of boxes was already read', loggedSkipKey)
        return
      }
      lastAtcBoxesKey.current = read.key
      const candidate = read.candidate
      if (!candidate) return
      logPrompt(`read ${describeClearance(candidate)}; selection: ${describeSelection(selection)}`)
      runAsync(
        'atc clearance offer',
        explainAtcClearance(candidate, selection).then((outcome) => {
          if (!outcome.offer) {
            logPrompt(`no prompt for "${candidate.summary}": ${outcome.reason}`)
            return
          }
          logPrompt(`offered ${describeClearance(outcome.offer)}`)
          setPending(outcome.offer)
        })
      )
    })
  }, [client, selection, hidden])

  useEffect(() => {
    if (!pending || popupMs === null) return
    const timer = setTimeout(() => {
      logPrompt(`no answer in ${popupMs / 1000} s: "${pending.summary}" moved to the BeyondATC page`)
      setMovedOn(pending)
    }, popupMs)
    return () => clearTimeout(timer)
  }, [pending, popupMs])

  // A clearance that is gone and was not answered here was replaced by a newer one, or withdrawn (below).
  useEffect(() => {
    const before = previous.current
    previous.current = pending
    if (!before || before === pending || before === answered.current) return
    logPrompt(
      pending
        ? `"${before.summary}" replaced by a newer clearance`
        : `"${before.summary}" withdrawn: ${hidden ? 'online' : 'the selection already holds it (answered on another screen)'}`
    )
  }, [pending, hidden])

  // The other screen answered it (the phone pressed Update, or the desktop did): the selection already holds what this one would
  // apply, so there is nothing left to ask, and a stale Update here must not be pressable. Adjusted while rendering, React's
  // pattern for state that follows a prop.
  if (pending && !clearanceDiffers(pending, selection)) setPending(null)
  if (pending && hidden) setPending(null)

  return {
    pending,
    popupOpen: pending !== null && movedOn !== pending,
    onAccept: () => {
      if (!pending) return
      logPrompt(`accepted "${pending.summary}"`)
      answered.current = pending
      setSelection((prev) => applyClearance(prev, pending.fields))
      setPending(null)
    },
    onDismiss: () => {
      if (pending) logPrompt(`dismissed "${pending.summary}"`)
      answered.current = pending
      setPending(null)
    }
  }
}

/**
 * Says once per set of boxes why a clearance in it was not offered, when it carries one.
 *
 * @param boxes The BeyondATC InfoBoxes just pushed.
 * @param why Why they are not offered.
 * @param lastKey The key of the set last said, updated here.
 * @param lastKey.current The ref's value.
 */
function logSkipped(boxes: BeyondAtcState['infoBoxes'], why: string, lastKey: { current: string }): void {
  const key = `${why}|${JSON.stringify(boxes)}`
  if (key === lastKey.current) return
  const clearance = parseAtcBoxClearance(boxes)
  if (!clearance) return
  lastKey.current = key
  logPrompt(`no prompt for "${clearance.summary}": ${why}`)
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
