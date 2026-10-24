/** A one-line note on Track (and the phone's Track) saying why BeyondATC is hidden: the pilot is online, and the network's controllers are the only voice. */
import { useTranslation } from 'react-i18next'
import { useOnlineStatus } from '../live/use-online-status'

/**
 * @returns The note while BeyondATC is hidden because the pilot is online, otherwise nothing.
 */
export function BeyondAtcHiddenNote(): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = useOnlineStatus()
  if (!status.hidesBeyondAtc || !status.network) return null
  return (
    <p
      role="status"
      className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
    >
      {t('online.beyondAtcHidden', { network: status.network === 'ivao' ? 'IVAO' : 'VATSIM' })}
    </p>
  )
}
