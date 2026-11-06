/** The map key: what the lines and fix symbols on the map mean. Closed to a small button by default; the choice is remembered. */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { uiMemory } from '../ui-memory'

/**
 * A 28 by 12 sample of a line, drawn with the theme's colours (the classes set the stroke through `currentColor`).
 *
 * @param props The line's colour class, width, dashes and whether it has a dark edge.
 * @returns The element.
 */
function LineSample(props: {
  className: string
  width: number
  dash?: string
  edge?: boolean
}): React.JSX.Element {
  return (
    <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" className={props.className}>
      {props.edge && (
        <line x1="1" y1="6" x2="27" y2="6" stroke="var(--foreground)" strokeWidth="6" opacity="0.7" />
      )}
      <line
        x1="1"
        y1="6"
        x2="27"
        y2="6"
        stroke="currentColor"
        strokeWidth={props.width}
        strokeDasharray={props.dash}
      />
    </svg>
  )
}

/**
 * A hollow fix symbol, drawn as the map draws it.
 *
 * @param props Which symbol.
 * @returns The element.
 */
function FixSample(props: { shape: 'enroute' | 'procedure' | 'approach' }): React.JSX.Element {
  const triangle = (size: number): string => `${size / 2},1.4 ${size - 1.4},${size - 1.4} 1.4,${size - 1.4}`
  return (
    <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true" className="text-muted-foreground">
      {props.shape === 'enroute' && (
        <g transform="translate(10 3)">
          <polygon points={triangle(8)} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </g>
      )}
      {props.shape === 'procedure' && (
        <g transform="translate(8 1)">
          <polygon points={triangle(12)} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </g>
      )}
      {props.shape === 'approach' && (
        <>
          <circle cx="14" cy="7" r="4.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="14" cy="7" r="1.3" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

/**
 * The key: a "Key" button at the map's top left; open, a list of the lines and fix symbols with a Hide button. Closed by default
 * (winglog-backend docs/plans/v2-design.md, "The map"); once opened or hidden the choice is remembered with the other map settings.
 *
 * @returns The element.
 */
export function MapKey(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(uiMemory().mapKeyOpen)
  const choose = (next: boolean): void => {
    uiMemory().mapKeyOpen = next
    setOpen(next)
  }
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="absolute top-3 left-3 bg-popover/90 backdrop-blur-sm"
        onClick={() => choose(true)}
      >
        {t('flightMap.key.show')}
      </Button>
    )
  }
  const row = (sample: React.JSX.Element, label: string): React.JSX.Element => (
    <li className="flex items-center gap-2">
      {sample}
      <span>{label}</span>
    </li>
  )
  return (
    <section
      aria-label={t('flightMap.key.title')}
      className="absolute top-3 left-3 w-56 rounded-md border border-border bg-popover/95 p-2.5 text-xs text-popover-foreground shadow-sm backdrop-blur-sm"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-sm font-medium">{t('flightMap.key.title')}</h2>
        <Button variant="ghost" size="xs" onClick={() => choose(false)}>
          {t('flightMap.key.hide')}
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {row(<LineSample className="text-foreground" width={3} />, t('flightMap.key.flown'))}
        {row(<LineSample className="text-plan" width={1.5} dash="6 4" />, t('flightMap.key.plan'))}
        {row(<LineSample className="text-[#f2c200]" width={3.5} edge />, t('flightMap.key.taxiRoute'))}
        {row(
          <LineSample className="text-[#2a62a3] dark:text-[#7fb0e8]" width={1.2} />,
          t('flightMap.key.atcArea')
        )}
        {row(<FixSample shape="enroute" />, t('flightMap.key.fixEnroute'))}
        {row(<FixSample shape="procedure" />, t('flightMap.key.fixProcedure'))}
        {row(<FixSample shape="approach" />, t('flightMap.key.fixApproach'))}
      </ul>
    </section>
  )
}
