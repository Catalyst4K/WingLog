/** A warning on Track (and the phone's Track) and above BeyondATC's toggles while BeyondATC's auto tune is on and the pilot is online. */
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { BeyondAtcConnectionStatus } from '@shared/ipc'
import { autoTuneWarning } from '@shared/beyondatc-online'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { useOnlineStatus } from '../live/use-online-status'
import { useSafeLiveTopic } from '../live/use-safe-live-topic'

const DISCONNECTED: BeyondAtcConnectionStatus = { state: 'disconnected', lastError: null }

/**
 * Auto tune retunes the radios, which online takes the pilot off the network controller's frequency. WingLog only warns: switching it off
 * is the pilot's choice, with BeyondATC's own toggle (`autoTuneWarning` has the rule).
 *
 * @returns The warning while a connected BeyondATC has auto tune on and the pilot is online, otherwise nothing.
 */
export function AutoTuneOnlineWarning(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useOnlineStatus()
  const link = useSafeLiveTopic('beyondAtcStatus', DISCONNECTED)
  const { autoTune } = useSafeLiveTopic('beyondAtcState', EMPTY_BEYONDATC_STATE)
  if (!status.network || !autoTuneWarning(status.state, link.state === 'connected', autoTune)) return null
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
      />
      <span>{t('online.autoTuneWarning', { network: status.network === 'ivao' ? 'IVAO' : 'VATSIM' })}</span>
    </p>
  )
}
