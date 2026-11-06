/** The firm/hard landing light and word. */

import { useTranslation } from 'react-i18next'
import type { LandingSeverity } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'

/**
 * Shared verbatim by Fleet (per-aircraft history) and Logbook (per-flight pane and list) so they
 * can never disagree about what counts as a hard landing (docs/decisions.md,
 * landing-analysis entry). Renders nothing for 'none' — most landings shouldn't be
 * decorated with anything, or the indicator stops meaning anything. A firm landing is an amber light and the word, a hard one a red
 * light and the word (winglog-backend docs/plans/v2-design.md: lights are state, never a coloured block).
 *
 * @param props The landing's severity.
 * @returns The light and word, or null for a normal landing.
 */
export function LandingBadge(props: { severity: LandingSeverity }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.severity === 'none') return null
  const hard = props.severity === 'hard'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusLight state={hard ? 'red' : 'amber'} />
      {hard ? t('landingBadge.hard') : t('landingBadge.firm')}
    </span>
  )
}
