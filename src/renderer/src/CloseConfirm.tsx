/** The in-app "Close WingLog?" question, asked while a flight is in progress (winglog-backend's docs/plans/tray.md). */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { winglogApi } from './data/winglog-api'
import { useConfirm } from './hooks/use-confirm'
import { runAsync } from './report-error'

/**
 * Shows a confirmation when the main process asks whether to close WingLog, and sends back the answer. The default
 * choice is Keep open, so a stray Enter or Escape leaves the flight running.
 *
 * @returns The dialog element.
 */
export function CloseConfirm(): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, dialog] = useConfirm()
  const ask = useRef<() => Promise<boolean>>(() => Promise.resolve(false))
  useEffect(() => {
    ask.current = () =>
      confirm({
        title: t('closeConfirm.title'),
        description: t('closeConfirm.description'),
        confirmLabel: t('closeConfirm.close'),
        cancelLabel: t('closeConfirm.keepOpen')
      })
  })

  useEffect(
    () =>
      winglogApi().onCloseConfirmRequested(() =>
        runAsync(
          'CloseConfirm closeConfirmAnswer',
          ask.current().then((close) => winglogApi().closeConfirmAnswer(close))
        )
      ),
    []
  )

  return dialog
}
