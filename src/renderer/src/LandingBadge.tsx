/** The firm/hard landing light. */

import { useTranslation } from 'react-i18next'
import type { LandingSeverity } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'

/**
 * Shared verbatim by Fleet (per-aircraft history) and Logbook (per-flight pane and list) so they can never disagree about what counts as
 * a hard landing (docs/decisions.md, landing-analysis entry). Renders nothing for 'none' — most landings shouldn't be decorated with
 * anything, or the indicator stops meaning anything. A firm landing is an amber light and a hard one a red light, with no word beside it
 * (Callum, 2026-11-06); the word is in the tooltip and for a screen reader.
 *
 * @param props The landing's severity.
 * @returns The light, or null for a normal landing.
 */
export function LandingBadge(props: { severity: LandingSeverity }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.severity === 'none') return null
  const hard = props.severity === 'hard'
  const word = hard ? t('landingBadge.hard') : t('landingBadge.firm')
  return (
    <span className="inline-flex items-center" title={word}>
      <StatusLight state={hard ? 'red' : 'amber'} />
      <span className="sr-only">{word}</span>
    </span>
  )
}
