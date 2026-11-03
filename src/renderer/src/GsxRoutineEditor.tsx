/** The GSX routine editor: name, services, the order they run in, and the two options. */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GSX_ROUTINE_MENU,
  GSX_ROUTINE_NAME_MAX,
  GSX_ROUTINE_SERVICES,
  routineServices,
  type GsxRoutine,
  type GsxRoutineService
} from '@shared/gsx-routines'
import type { GsxRoutinesResult } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { winglogApi } from './data/winglog-api'
import {
  copyRoutine,
  moveService,
  newRoutineId,
  routineProblem,
  setStartsWhen,
  toggleService
} from './gsx-routine-edit'
import { routineName, serviceLabel } from './gsx-routine-text'
import { asyncHandler } from './report-error'
import { SegmentedRow } from './SettingsFields'

const SELECT_CLASS =
  'h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The services to tick, split the way GSX splits them: its main menu, and one level down.
 *
 * @param props What is ticked, and what to do when one is clicked.
 * @returns The element.
 */
function ServicePicker(props: {
  ticked: readonly GsxRoutineService[]
  readOnly: boolean
  onToggle: (service: GsxRoutineService) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const groups = [
    {
      key: 'groupMain',
      services: GSX_ROUTINE_SERVICES.filter((s) => !GSX_ROUTINE_MENU[s].viaAdditionalServices)
    },
    {
      key: 'groupAdditional',
      services: GSX_ROUTINE_SERVICES.filter((s) => GSX_ROUTINE_MENU[s].viaAdditionalServices)
    }
  ]
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{t('gsxRoutines.editor.servicesHeading')}</p>
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t(`gsxRoutines.editor.${group.key}`)}</span>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t(`gsxRoutines.editor.${group.key}`)}
          >
            {group.services.map((service) => (
              <Button
                key={service}
                type="button"
                size="sm"
                variant={props.ticked.includes(service) ? 'default' : 'outline'}
                aria-pressed={props.ticked.includes(service)}
                disabled={props.readOnly}
                onClick={() => props.onToggle(service)}
              >
                {serviceLabel(t, service)}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The order the routine runs in: each stage, what it waits for, and where each service sits.
 *
 * @param props The routine, whether it can be changed, and what to do with a change.
 * @returns The element.
 */
function StageEditor(props: {
  routine: GsxRoutine
  readOnly: boolean
  onChange: (routine: GsxRoutine) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { stages } = props.routine
  if (stages.length === 0) return null
  const change = (next: GsxRoutine['stages']): void => props.onChange({ ...props.routine, stages: next })
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{t('gsxRoutines.editor.stagesHeading')}</p>
      <ol className="flex flex-col gap-2">
        {stages.map((stage, index) => {
          const earlier = stages.slice(0, index).flatMap((s) => s.services)
          return (
            <li
              key={stage.services.join('+')}
              className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">
                  {t('gsxRoutines.editor.stage', { n: index + 1 })}
                </span>
                {index === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('gsxRoutines.editor.startsAtOnce')}
                  </span>
                ) : (
                  <select
                    className={SELECT_CLASS}
                    aria-label={t('gsxRoutines.editor.startsLabel', { n: index + 1 })}
                    disabled={props.readOnly}
                    value={stage.startsWhen[0]?.service ?? ''}
                    onChange={(e) =>
                      change(
                        setStartsWhen(stages, index, (e.target.value || null) as GsxRoutineService | null)
                      )
                    }
                  >
                    <option value="">{t('gsxRoutines.editor.startsAtOnce')}</option>
                    {earlier.map((service) => (
                      <option key={service} value={service}>
                        {t('gsxRoutines.editor.startsWhenDone', { service: serviceLabel(t, service) })}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {stage.services.map((service) => (
                  <li key={service} className="flex items-center gap-1.5 text-xs">
                    <span>{serviceLabel(t, service)}</span>
                    <select
                      className={SELECT_CLASS}
                      aria-label={t('gsxRoutines.editor.moveLabel', { service: serviceLabel(t, service) })}
                      disabled={props.readOnly}
                      value={index}
                      onChange={(e) => change(moveService(stages, service, Number(e.target.value)))}
                    >
                      {stages.map((_, target) => (
                        <option key={target} value={target}>
                          {t('gsxRoutines.editor.stage', { n: target + 1 })}
                        </option>
                      ))}
                      <option value={stages.length}>{t('gsxRoutines.editor.newStage')}</option>
                    </select>
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ol>
      {!props.readOnly && (
        <p className="text-xs text-muted-foreground">{t('gsxRoutines.editor.relayNote')}</p>
      )}
    </div>
  )
}

/**
 * The editor's two options: whether the routine answers GSX's own default for the pilot, and how it answers the refuelling level.
 *
 * @param props The routine, whether it can be changed, and what to do with a change.
 * @returns The element.
 */
function OptionRows(props: {
  routine: GsxRoutine
  readOnly: boolean
  onChange: (routine: GsxRoutine) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { routine } = props
  const noop = (): void => undefined
  return (
    <div className="flex flex-col gap-2">
      <SegmentedRow
        label={t('gsxRoutines.editor.answerGsxChoice')}
        value={routine.answerGsxChoice ? 'on' : 'off'}
        options={[
          { value: 'off', label: t('gsxRoutines.editor.no') },
          { value: 'on', label: t('gsxRoutines.editor.yes') }
        ]}
        onChange={
          props.readOnly ? noop : (value) => props.onChange({ ...routine, answerGsxChoice: value === 'on' })
        }
        note={t('gsxRoutines.editor.answerGsxChoiceNote')}
      />
      <SegmentedRow
        label={t('gsxRoutines.editor.fuel')}
        value={routine.fuel}
        options={[
          { value: 'ask', label: t('gsxRoutines.editor.fuelAsk') },
          { value: 'simbrief-block', label: t('gsxRoutines.editor.fuelBlock') }
        ]}
        onChange={props.readOnly ? noop : (value) => props.onChange({ ...routine, fuel: value })}
      />
    </div>
  )
}

/**
 * The bar that asks "are you sure?" before a routine is deleted, in place of the buttons at the foot of the editor.
 *
 * @param props The routine's name, whether it is a built-in, and what to do.
 * @returns The element.
 */
function DeleteConfirmation(props: {
  name: string
  isBuiltIn: boolean
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const barRef = useRef<HTMLDivElement>(null)
  // The dialog scrolls on a small window; keep the question in view (jsdom has no scrollIntoView).
  useEffect(() => {
    barRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])
  return (
    <div
      ref={barRef}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3"
      data-testid="gsx-routine-delete-confirmation"
    >
      <p className="text-sm text-foreground">
        {t(
          props.isBuiltIn ? 'gsxRoutines.editor.confirmDeleteBuiltIn' : 'gsxRoutines.editor.confirmDeleteOwn',
          {
            name: props.name
          }
        )}
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
          {t('gsxRoutines.editor.cancelDelete')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {t('gsxRoutines.editor.delete')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The buttons at the foot of the editor. Every stored routine and every built-in can be deleted (a built-in only leaves the list); a
 * built-in cannot be saved over, so it offers Duplicate and Delete; a routine of the pilot's own also Save. Delete asks first.
 *
 * @param props What the buttons need to know, and do.
 * @returns The element.
 */
function EditorButtons(props: {
  name: string
  readOnly: boolean
  canSave: boolean
  isStored: boolean
  busy: boolean
  onSave: () => void
  onDuplicate: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  if (confirmingDelete) {
    return (
      <DeleteConfirmation
        name={props.name}
        isBuiltIn={props.readOnly}
        busy={props.busy}
        onConfirm={props.onDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    )
  }
  return (
    <DialogFooter className="gap-2 sm:justify-between">
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onDuplicate}>
          {t('gsxRoutines.editor.duplicate')}
        </Button>
        {(props.isStored || props.readOnly) && (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDelete(true)}>
            {t('gsxRoutines.editor.delete')}
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
          {t('gsxRoutines.editor.close')}
        </Button>
        {!props.readOnly && (
          <Button type="button" size="sm" disabled={!props.canSave || props.busy} onClick={props.onSave}>
            {t('gsxRoutines.editor.save')}
          </Button>
        )}
      </div>
    </DialogFooter>
  )
}

/**
 * The dialog for one routine. A built-in is shown as it is and can be duplicated or deleted; Duplicate on any routine opens an
 * editable copy. Saving goes to the main process, which checks the routine again.
 *
 * @param props The routine, whether it is already stored, and what to do when the dialog closes or the list changes.
 * @returns The dialog.
 */
export function GsxRoutineEditor(props: {
  routine: GsxRoutine
  isStored: boolean
  onClose: () => void
  onChanged: (routines: GsxRoutine[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(props.routine)
  const [isStored, setIsStored] = useState(props.isStored)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const readOnly = draft.builtIn !== undefined
  const problem = routineProblem(draft)

  const save = async (): Promise<void> => {
    setBusy(true)
    const result: GsxRoutinesResult = await winglogApi().gsxRoutinesSave({
      ...draft,
      name: draft.name.trim()
    })
    setBusy(false)
    if (!result.ok) {
      setError(t('gsxRoutines.editor.saveFailed', { reason: result.reason }))
      return
    }
    props.onChanged(result.routines)
    props.onClose()
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    props.onChanged(await winglogApi().gsxRoutinesDelete(draft.id))
    setBusy(false)
    props.onClose()
  }
  const duplicate = (): void => {
    setDraft(
      copyRoutine(draft, newRoutineId(), t('gsxRoutines.editor.copyOf', { name: routineName(t, draft) }))
    )
    setIsStored(false)
    setError(null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t(isStored ? 'gsxRoutines.editor.titleEdit' : 'gsxRoutines.editor.titleNew')}
          </DialogTitle>
          <DialogDescription>
            {readOnly ? t('gsxRoutines.editor.builtInNote') : t('gsxRoutines.editor.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Label className="flex flex-col items-start gap-1.5">
            {t('gsxRoutines.editor.name')}
            <Input
              value={routineName(t, draft)}
              maxLength={GSX_ROUTINE_NAME_MAX}
              readOnly={readOnly}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Label>
          <ServicePicker
            ticked={routineServices(draft)}
            readOnly={readOnly}
            onToggle={(service) => setDraft({ ...draft, stages: toggleService(draft.stages, service) })}
          />
          <StageEditor routine={draft} readOnly={readOnly} onChange={setDraft} />
          <OptionRows routine={draft} readOnly={readOnly} onChange={setDraft} />
          {!readOnly && problem === 'services' && (
            <p className="text-xs text-muted-foreground">{t('gsxRoutines.editor.noServices')}</p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <EditorButtons
          name={routineName(t, draft)}
          readOnly={readOnly}
          canSave={problem === null}
          isStored={isStored}
          busy={busy}
          onSave={asyncHandler('GsxRoutineEditor save', save)}
          onDuplicate={duplicate}
          onDelete={asyncHandler('GsxRoutineEditor delete', remove)}
          onClose={props.onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
