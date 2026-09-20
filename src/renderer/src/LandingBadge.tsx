import { useTranslation } from 'react-i18next'
import type { LandingSeverity } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'

/** Shared verbatim by Fleet (per-aircraft history) and Logbook (per-flight pane) so they
 *  can never disagree about what counts as a hard landing (docs/decisions.md,
 *  landing-analysis entry). Renders nothing for 'none' — most landings shouldn't be
 *  decorated with anything, or the indicator stops meaning anything. */
export function LandingBadge(props: { severity: LandingSeverity }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.severity === 'none') return null
  return (
    <Badge variant={props.severity === 'hard' ? 'destructive' : 'secondary'}>
      {props.severity === 'hard' ? t('landingBadge.hard') : t('landingBadge.firm')}
    </Badge>
  )
}
