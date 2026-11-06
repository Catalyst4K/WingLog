/** A state light: one small dot (or a short row of them) for a state, never a coloured block. */

import { cn } from '@/lib/utils'

/** What a light says: green connected or done, amber connecting or waiting on you, red lost or hard, off still to come. */
export type LightState = 'green' | 'amber' | 'red' | 'off'

const LIGHT_COLOUR: Record<LightState, string> = {
  green: 'bg-light-green',
  amber: 'bg-light-amber',
  red: 'bg-light-red',
  off: 'bg-light-off'
}

/**
 * A state light (winglog-backend docs/plans/v2-design.md, "The design rules": lights are state, and off when normal). Decorative: put
 * the state in words beside it, since a colour alone is not read by everyone.
 *
 * @param props The state, how many dots (the sim connection uses three), and extra classes.
 * @returns The element.
 */
export function StatusLight(props: {
  state: LightState
  count?: number
  className?: string
}): React.JSX.Element {
  const dots = Array.from({ length: props.count ?? 1 }, (_, i) => i)
  return (
    <span
      aria-hidden="true"
      data-slot="status-light"
      data-state={props.state}
      className={cn('inline-flex shrink-0 items-center gap-1', props.className)}
    >
      {dots.map((i) => (
        <span key={i} className={cn('size-2 rounded-full', LIGHT_COLOUR[props.state])} />
      ))}
    </span>
  )
}
