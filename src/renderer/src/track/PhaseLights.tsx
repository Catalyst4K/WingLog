/** The flight's phases as a row of dots: on the Track screen and on a phone. */

import type { FlightPhase } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'

/** The phases of a flight, in order, as the strip shows them. */
const PHASE_ORDER: FlightPhase[] = [
  'pushback',
  'taxi',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'landing',
  'shutdown'
]

/**
 * The flight's phases as a row of dots (winglog-backend docs/plans/v2-design.md, "Track", and the canvas): green for those done, a larger
 * ringed green dot with its name for the one it is in, off for those still to come. The other names are there for a screen reader.
 *
 * @param props The phase the flight is in.
 * @returns The element.
 */
export function PhaseLights(props: { phase: FlightPhase; compact?: boolean }): React.JSX.Element {
  const current = PHASE_ORDER.indexOf(props.phase)
  return (
    <ol className="m-0 flex list-none items-center gap-1.5 p-0" data-testid="phase-lights">
      {PHASE_ORDER.map((phase, index) => {
        const isCurrent = index === current
        return (
          <li
            key={phase}
            aria-current={isCurrent ? 'step' : undefined}
            className="inline-flex items-center gap-2 capitalize"
          >
            {isCurrent ? (
              <span
                aria-hidden="true"
                data-slot="status-light"
                data-state="green"
                className="size-[13px] rounded-full border-2 border-foreground bg-light-green"
              />
            ) : (
              <StatusLight state={index < current ? 'green' : 'off'} />
            )}
            <span className={isCurrent ? `mr-1 ${props.compact ? 'text-[13px]' : 'text-[17px]'}` : 'sr-only'}>
              {phase}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
