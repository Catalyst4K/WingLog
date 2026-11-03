/**
 * The Routines row of the GSX page: one button per routine, the progress of the one running, and (on the PC) New routine, an Edit
 * toggle that turns the routine buttons into edit buttons, and the editor.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus } from 'lucide-react'
import type { GsxRoutine } from '@shared/gsx-routines'
import type { GsxRoutineProgress, GsxRoutineServiceProgress } from '@shared/gsx-routine-progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { winglogApi } from './data/winglog-api'
import { GsxRoutineEditor } from './GsxRoutineEditor'
import { blankRoutine, newRoutineId } from './gsx-routine-edit'
import { describeNote, routineName, serviceLabel } from './gsx-routine-text'
import { useLiveClient, useLiveTopic } from './live/LiveClient'
import { asyncHandler, runAsync } from './report-error'

const NO_ROUTINES: GsxRoutine[] = []

/** The look of each service in the progress list. */
const CHIP_VARIANT: Record<GsxRoutineServiceProgress, 'default' | 'secondary' | 'outline'> = {
  waiting: 'outline',
  asking: 'secondary',
  running: 'secondary',
  done: 'default',
  skipped: 'outline'
}

/**
 * The routine that is running, or ran lately: its stage, each service, the status line and Cancel.
 *
 * @param props The progress, and what to do on Cancel.
 * @returns The element.
 */
function RoutineProgress(props: { progress: GsxRoutineProgress; onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { progress } = props
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3"
      data-testid="gsx-routine-progress"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {routineName(t, { id: progress.routineId, name: progress.routineName })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('gsxRoutines.stageOf', { stage: progress.stage, count: progress.stageCount })}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {progress.services.map(({ service, progress: state }) => (
          <li key={service}>
            <Badge variant={CHIP_VARIANT[state]} className="h-auto gap-1 py-0.5 text-[11px] font-normal">
              {serviceLabel(t, service)}
              <span className="text-[10px] opacity-80">{t(`gsxRoutines.state.${state}`)}</span>
            </Badge>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {describeNote(t, progress.note)}
      </p>
      {progress.state === 'running' && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
            {t('gsxRoutines.cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The Routines row. The buttons start a routine through the live command, so a phone starts one the same way; the editor is
 * only on the PC (`canEdit`).
 *
 * @param props Whether this screen may edit routines.
 * @returns The element.
 */
export function GsxRoutines(props: { canEdit: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const live = useLiveClient()
  const progress = useLiveTopic('gsxRoutine', null)
  const [routines, setRoutines] = useState(NO_ROUTINES)
  const [editing, setEditing] = useState<{ routine: GsxRoutine; isStored: boolean } | null>(null)
  const isRunning = progress?.state === 'running'
  const [isEditMode, setIsEditMode] = useState(false)

  useEffect(() => {
    runAsync('GsxRoutines gsxRoutinesList', winglogApi().gsxRoutinesList().then(setRoutines))
  }, [])

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('gsxRoutines.title')}</p>
      {progress && (
        <RoutineProgress
          progress={progress}
          onCancel={asyncHandler('GsxRoutines gsx.cancelRoutine', () => live.command('gsx.cancelRoutine'))}
        />
      )}
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('gsxRoutines.title')}>
        {routines.map((routine) => (
          <li key={routine.id}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isRunning && !isEditMode}
              aria-label={isEditMode ? t('gsxRoutines.edit', { name: routineName(t, routine) }) : undefined}
              onClick={
                isEditMode
                  ? () => setEditing({ routine, isStored: routine.builtIn === undefined })
                  : asyncHandler('GsxRoutines gsx.startRoutine', () =>
                      live.command('gsx.startRoutine', routine.id)
                    )
              }
            >
              {isEditMode && <Pencil aria-hidden="true" className="size-3.5" />}
              {routineName(t, routine)}
            </Button>
          </li>
        ))}
        {props.canEdit && (
          <>
            <li className="ml-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setEditing({
                    routine: blankRoutine(newRoutineId(), t('gsxRoutines.newName')),
                    isStored: false
                  })
                }
              >
                <Plus aria-hidden="true" className="size-3.5" />
                {t('gsxRoutines.new')}
              </Button>
            </li>
            <li>
              <Button
                type="button"
                variant={isEditMode ? 'default' : 'outline'}
                size="sm"
                aria-pressed={isEditMode}
                onClick={() => setIsEditMode(!isEditMode)}
              >
                <Pencil aria-hidden="true" className="size-3.5" />
                {t('gsxRoutines.editButton')}
              </Button>
            </li>
          </>
        )}
      </ul>
      {editing && (
        <GsxRoutineEditor
          routine={editing.routine}
          isStored={editing.isStored}
          onClose={() => setEditing(null)}
          onChanged={setRoutines}
        />
      )}
    </div>
  )
}
