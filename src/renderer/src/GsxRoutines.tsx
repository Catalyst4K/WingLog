/**
 * The Routines row of the GSX page: one button per routine, the progress of the one running, and (on the PC) New routine, an Edit
 * toggle that turns the routine buttons into edit buttons, and the editor.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GsxRoutine, GsxRoutineService } from '@shared/gsx-routines'
import type {
  GsxRoutineCancelChoice,
  GsxRoutineProgress,
  GsxRoutineServiceProgress
} from '@shared/gsx-routine-progress'
import { Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { winglogApi } from './data/winglog-api'
import { GsxRoutineEditor } from './GsxRoutineEditor'
import { blankRoutine, copyRoutine, newRoutineId } from './gsx-routine-edit'
import { describeNote, routineName, serviceLabel, serviceList } from './gsx-routine-text'
import { useLiveClient, useLiveTopic } from './live/LiveClient'
import { useDataChanged } from './app/use-data-changed'
import { asyncHandler, runAsync } from './report-error'

const NO_ROUTINES: GsxRoutine[] = []

/** The light of each service in the progress list: filled green when done, a ring while it is being asked for or under way, off otherwise. */
const STEP_DOT: Record<GsxRoutineServiceProgress, string> = {
  waiting: 'bg-light-off',
  asking: 'box-border border-2 border-light-green',
  running: 'box-border border-2 border-light-green',
  done: 'bg-light-green',
  skipped: 'bg-light-off'
}

/**
 * What Cancel does when services are under way (winglog-backend's docs/plans/gsx-routine-cancel.md): a pop-up in the middle of the
 * window asks whether to abort them, complete them, or leave them running, or to keep the routine going (also what Escape does).
 *
 * @param props The services under way, what to do with them, and how to go back.
 * @returns The element.
 */
function CancelPrompt(props: {
  services: GsxRoutineService[]
  onChoose: (choice: GsxRoutineCancelChoice) => void
  onKeepGoing: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && props.onKeepGoing()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-bold">
            {t('gsxRoutines.cancelPrompt.label')}
          </DialogTitle>
          <DialogDescription>
            {t('gsxRoutines.cancelPrompt.question', { services: serviceList(t, props.services) })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" className="h-10" onClick={() => props.onChoose('abort')}>
            {t('gsxRoutines.cancelPrompt.abort')}
          </Button>
          <Button type="button" variant="outline" className="h-10" onClick={() => props.onChoose('complete')}>
            {t('gsxRoutines.cancelPrompt.complete')}
          </Button>
          <Button type="button" variant="outline" className="h-10" onClick={() => props.onChoose('leave')}>
            {t('gsxRoutines.cancelPrompt.leave')}
          </Button>
          <Button type="button" className="h-10" onClick={props.onKeepGoing}>
            {t('gsxRoutines.cancelPrompt.keepGoing')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The routine that is running, or ran lately: its stage, each service, the status line and Cancel. With services under way Cancel
 * first asks what to do with them.
 *
 * @param props The progress, and what to do on Cancel.
 * @returns The element.
 */
function RoutineProgress(props: {
  progress: GsxRoutineProgress
  onCancel: (choice?: GsxRoutineCancelChoice) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { progress } = props
  const [isAsking, setIsAsking] = useState(false)
  const underWay = progress.services
    .filter(({ progress: state }) => state === 'running')
    .map(({ service }) => service)
  const isEnding = progress.note.code === 'ending'
  return (
    <div
      className="mt-4 flex flex-col gap-2 border-t border-border pt-3.5"
      data-testid="gsx-routine-progress"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-foreground">
          {routineName(t, { id: progress.routineId, name: progress.routineName })}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {t('gsxRoutines.stageOf', { stage: progress.stage, count: progress.stageCount })}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-[18px] gap-y-1.5 p-0">
        {progress.services.map(({ service, progress: state }) => (
          <li key={service} className="flex items-center gap-[7px] text-sm">
            <span aria-hidden="true" className={`size-[9px] shrink-0 rounded-full ${STEP_DOT[state]}`} />
            {serviceLabel(t, service)}
            <span className="text-muted-foreground">{t(`gsxRoutines.state.${state}`)}</span>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="m-0 text-sm text-muted-foreground">
        {describeNote(t, progress.note)}
      </p>
      {progress.state === 'running' && !isEnding && isAsking && (
        <CancelPrompt
          services={underWay}
          onChoose={(choice) => {
            setIsAsking(false)
            props.onCancel(choice)
          }}
          onKeepGoing={() => setIsAsking(false)}
        />
      )}
      {progress.state === 'running' && !isEnding && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => (underWay.length > 0 ? setIsAsking(true) : props.onCancel())}
          >
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

  const load = (): void =>
    runAsync('GsxRoutines gsxRoutinesList', winglogApi().gsxRoutinesList().then(setRoutines))
  useEffect(load, [])
  // A routine made or changed on the other computer arrives by sync: read the list again.
  useDataChanged(load)

  return (
    <section
      className="flex flex-col rounded-b-md border-t-[3px] border-foreground bg-card px-5 pt-4 pb-[18px]"
      aria-label={t('gsxRoutines.title')}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="m-0 font-display text-[17px] font-bold tracking-[-0.01em] text-foreground">
          {t('gsxRoutines.title')}
        </h3>
        {props.canEdit && (
          <span className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setEditing({
                  routine: blankRoutine(newRoutineId(), t('gsxRoutines.newName')),
                  isStored: false
                })
              }
            >
              {t('gsxRoutines.new')}
            </Button>
            <Button
              type="button"
              variant={isEditMode ? 'default' : 'outline'}
              aria-pressed={isEditMode}
              onClick={() => setIsEditMode(!isEditMode)}
            >
              <Pencil data-icon="inline-start" />
              {t('gsxRoutines.editButton')}
            </Button>
          </span>
        )}
      </div>
      {isEditMode && <p className="mt-0 mb-3 text-sm text-muted-foreground">{t('gsxRoutines.editHint')}</p>}
      <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0" aria-label={t('gsxRoutines.title')}>
        {routines.map((routine) => (
          <li key={routine.id}>
            <Button
              type="button"
              variant="outline"
              className={cn(
                'h-12 px-4',
                progress?.routineId === routine.id && 'border-foreground font-semibold',
                isEditMode && 'border-dashed border-foreground'
              )}
              disabled={isRunning && !isEditMode}
              aria-label={isEditMode ? t('gsxRoutines.edit', { name: routineName(t, routine) }) : undefined}
              onClick={
                isEditMode
                  ? () =>
                      setEditing({
                        routine: copyRoutine(routine, routine.id, routineName(t, routine)),
                        isStored: true
                      })
                  : asyncHandler('GsxRoutines gsx.startRoutine', () =>
                      live.command('gsx.startRoutine', routine.id)
                    )
              }
            >
              {isEditMode && <Pencil data-icon="inline-start" />}
              {routineName(t, routine)}
            </Button>
          </li>
        ))}
      </ul>
      {progress && (
        <RoutineProgress
          progress={progress}
          onCancel={(choice) =>
            asyncHandler('GsxRoutines gsx.cancelRoutine', () =>
              live.command('gsx.cancelRoutine', ...(choice === undefined ? [] : [choice]))
            )()
          }
        />
      )}
      {editing && (
        <GsxRoutineEditor
          routine={editing.routine}
          isStored={editing.isStored}
          onClose={() => setEditing(null)}
          onChanged={setRoutines}
        />
      )}
    </section>
  )
}
