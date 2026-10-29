/** The badge in the header (and the phone's flight banner) saying the pilot is online: the network and the callsign found in its feed. */
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useOnlineStatus } from '../live/use-online-status'

/**
 * The one "you are online" readout on every screen (Callum, 2026-10-29). A "probably" match, by the flight plan and position without a
 * CID, ends in a question mark and says why in its title.
 *
 * @param props Extra classes for where it sits.
 * @returns The badge while the pilot is online or probably is, otherwise nothing.
 */
export function OnlineBadge(props: { className?: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { network, state, callsign } = useOnlineStatus()
  if (!network || !callsign || (state !== 'online' && state !== 'probably')) return null
  const name = network === 'ivao' ? 'IVAO' : 'VATSIM'
  const probably = state === 'probably'
  return (
    <Badge
      variant="outline"
      title={t(probably ? 'online.badgeProbably' : 'online.badgeTitle', { network: name, callsign })}
      className={cn('shrink-0', props.className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
      {`${name} · ${callsign}${probably ? '?' : ''}`}
    </Badge>
  )
}
