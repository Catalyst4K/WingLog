/** The flight's phases as a row of dots: on the Track screen and on a phone. */

import { useTranslation } from 'react-i18next'
import type { FlightPhase } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'

/**
 * One light on the strip: the phase it stands for, and the key of its name under `trackView.phases`. The phase machine has one 'taxi',
 * so the strip has two lights for it, told apart by whether the flight is past its landing.
 */
interface StripLight {
  phase: FlightPhase
  nameKey: string
  /** Set on the two taxi lights: whether this one is the taxi after a landing. */
  pastLanding?: boolean
}

/** The phases of a flight, in order, as the strip shows them. */
const STRIP: StripLight[] = [
  { phase: 'pushback', nameKey: 'pushback' },
  { phase: 'taxi', nameKey: 'taxiOut', pastLanding: false },
  { phase: 'takeoff', nameKey: 'takeoff' },
  { phase: 'climb', nameKey: 'climb' },
  { phase: 'cruise', nameKey: 'cruise' },
  { phase: 'descent', nameKey: 'descent' },
  { phase: 'landing', nameKey: 'landing' },
  { phase: 'taxi', nameKey: 'taxiIn', pastLanding: true },
  { phase: 'shutdown', nameKey: 'shutdown' }
]

/**
 * @param phase The phase the flight is in.
 * @param pastLanding Whether the flight is past its landing (decides which taxi light a 'taxi' phase is).
 * @returns The strip's index of the light it is on, or -1 before the flight has begun.
 */
function currentIndex(phase: FlightPhase, pastLanding: boolean): number {
  return STRIP.findIndex(
    (light) => light.phase === phase && (light.pastLanding === undefined || light.pastLanding === pastLanding)
  )
}

/**
 * The flight's phases as a row of dots (winglog-backend docs/plans/v2-design.md, "Track", and the canvas): green for those done, a larger
 * ringed green dot with its name for the one it is in, off for those still to come. The other names are there for a screen reader.
 *
 * @param props The phase the flight is in, and whether it is past its landing (`isPastLanding` in `@shared/phase-strip`), which makes a
 * 'taxi' the second taxi light, "Taxi in".
 * @returns The element.
 */
export function PhaseLights(props: {
  phase: FlightPhase
  pastLanding?: boolean
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const current = currentIndex(props.phase, props.pastLanding ?? false)
  return (
    <ol className="m-0 flex list-none items-center gap-1.5 p-0" data-testid="phase-lights">
      {STRIP.map((light, index) => {
        const isCurrent = index === current
        return (
          <li
            key={light.nameKey}
            aria-current={isCurrent ? 'step' : undefined}
            className="inline-flex items-center gap-2"
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
              {t(`trackView.phases.${light.nameKey}`)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
