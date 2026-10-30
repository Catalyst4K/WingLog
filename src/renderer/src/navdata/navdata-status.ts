/** What navigation data the sim has, as the screens ask for it (winglog-backend docs/plans/navdata-cycle-check.md). */
import { useEffect, useState } from 'react'
import type { NavdataStatus } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'

/**
 * @returns The status, once main has read it, and null until then.
 */
export function useNavdataStatus(): NavdataStatus | null {
  const [status, setStatus] = useState<NavdataStatus | null>(null)
  useEffect(() => {
    let current = true
    runAsync(
      'NavdataCycle status',
      winglogApi()
        .navdataGetStatus()
        .then((next) => {
          if (current) setStatus(next)
        })
    )
    return () => {
      current = false
    }
  }, [])
  return status
}

/**
 * What is wrong, if anything: a Navigraph cycle behind the calendar's, or a plan made with a different cycle from the sim's. The
 * comparison needs the sim's cycle, so the sim's own data never has either.
 *
 * @param status What the sim has.
 * @param planAirac The cycle the plan was made with, when there is a plan and it says.
 * @returns Which warning to show, or null.
 */
export function navdataWarning(
  status: NavdataStatus,
  planAirac?: string | null
): 'behind' | 'planMismatch' | null {
  if (status.state === 'behind') return 'behind'
  if (status.source === 'navigraph' && status.cycle && planAirac && planAirac !== status.cycle)
    return 'planMismatch'
  return null
}
