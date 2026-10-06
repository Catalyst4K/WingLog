/**
 * Dev build only: keeps a flight's full capture for good, so it's never pruned with the newest 50
 * (flightdeck-backend docs/plans/robustness/scenario-testing.md, Answers 1). Shown in the
 * Logbook's flight detail. English only, like the DEV badge: the dev build is never shipped.
 */
import { useEffect, useState } from 'react'
import { Archive } from 'lucide-react'
import { toast } from 'sonner'
import type { CaptureKeepState } from '@shared/ipc'
import { Button } from '@/components/ui/button'

/**
 * @param isDevBuild Defaults to the build flag; a prop so both builds can be tested.
 */
export function KeepCaptureButton({
  flightId,
  isDevBuild = __WINGLOG_DEV_BUILD__
}: {
  flightId: number
  isDevBuild?: boolean
}): React.JSX.Element | null {
  const [state, setState] = useState<CaptureKeepState>('none')

  useEffect(() => {
    if (!isDevBuild) return
    let current = true
    window.winglog
      .captureKeepState(flightId)
      .then((next) => {
        if (current) setState(next)
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    return () => {
      current = false
    }
  }, [flightId, isDevBuild])

  async function handleKeep(): Promise<void> {
    try {
      const next = await window.winglog.captureKeep(flightId)
      setState(next)
      if (next === 'kept') toast.success('Capture kept: it will never be deleted automatically')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (!isDevBuild || state === 'none') return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleKeep}
      disabled={state === 'kept'}
      title="Dev build: move this flight's capture into captures\kept"
    >
      <Archive />
      {state === 'kept' ? 'Capture kept' : 'Keep capture'}
    </Button>
  )
}
