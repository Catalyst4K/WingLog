/**
 * The words for a GSX routine's services and its status line. The runner reports a code and its values; each screen words it
 * in the pilot's language here (src/renderer/src/locales, `gsxRoutines`).
 */
import type { TFunction } from 'i18next'
import type { GsxRoutineNote, GsxRoutineSkipReason, GsxRoutineStopReason } from '@shared/gsx-routine-progress'
import { BUILT_IN_ROUTINES, type GsxRoutineBuiltIn, type GsxRoutineService } from '@shared/gsx-routines'

/**
 * @param t The translator.
 * @param service A routine service.
 * @returns Its name in the pilot's language.
 */
export function serviceLabel(t: TFunction, service: GsxRoutineService): string {
  return t(`gsxRoutines.services.${service}`)
}

/**
 * @param t The translator.
 * @param services Some routine services.
 * @returns Their names, joined as a list.
 */
export function serviceList(t: TFunction, services: readonly GsxRoutineService[]): string {
  return services.map((service) => serviceLabel(t, service)).join(', ')
}

const BUILT_IN_KEY: Record<GsxRoutineBuiltIn, string> = {
  'fenix-departure': 'departure',
  arrival: 'arrival',
  'turnaround-clean': 'turnaroundClean'
}

/**
 * A routine's name as the pilot reads it: an example that still has its own name is worded in their language; a name they typed (a new
 * routine, or an example they renamed) is shown as typed.
 *
 * @param t The translator.
 * @param routine The routine, or the id and name of one that is running.
 * @returns The name to show.
 */
export function routineName(
  t: TFunction,
  routine: { id: string; name: string; builtIn?: GsxRoutineBuiltIn }
): string {
  const example = BUILT_IN_ROUTINES.find(
    (r) => r.builtIn !== undefined && (routine.builtIn === r.builtIn || routine.id === r.id)
  )
  const isUnrenamed =
    example !== undefined && (routine.builtIn !== undefined || routine.name === example.name)
  return isUnrenamed && example.builtIn
    ? t(`gsxRoutines.builtIn.${BUILT_IN_KEY[example.builtIn]}`)
    : routine.name
}

const STOP_KEY: Record<GsxRoutineStopReason, string> = {
  cancelled: 'cancelled',
  'gsx-disconnected': 'gsxDisconnected',
  'aircraft-moved': 'aircraftMoved',
  departure: 'departure',
  'menu-failed': 'menuFailed',
  'gsx-has-no-plan': 'gsxHasNoPlan',
  'no-planned-weight': 'noPlannedWeight'
}

const SKIP_KEY: Record<GsxRoutineSkipReason, string> = {
  'not-offered': 'notOffered',
  dropped: 'dropped',
  bypassed: 'bypassed'
}

/**
 * @param t The translator.
 * @param gapKg How far a fuel jump is from its target, or null.
 * @returns Why Boarding is waiting for the fuel.
 */
function fuelEntryText(t: TFunction, gapKg: number | null): string {
  return gapKg === null
    ? t('gsxRoutines.note.waitingForFuelEntry')
    : t('gsxRoutines.note.waitingForFuelEntryGap', { kg: gapKg })
}

/**
 * @param t The translator.
 * @param services The services under way.
 * @returns What the routine is waiting for; the starting line when nothing is under way yet.
 */
function followingText(t: TFunction, services: readonly GsxRoutineService[]): string {
  return services.length > 0
    ? t('gsxRoutines.note.following', { services: serviceList(t, services) })
    : t('gsxRoutines.note.starting')
}

/**
 * @param t The translator.
 * @param note The runner's status.
 * @returns The status line in the pilot's language.
 */
export function describeNote(t: TFunction, note: GsxRoutineNote): string {
  switch (note.code) {
    case 'starting':
      return t('gsxRoutines.note.starting')
    case 'opening-menu':
      return t('gsxRoutines.note.openingMenu', { service: serviceLabel(t, note.service) })
    case 'asking':
      return t('gsxRoutines.note.asking', { service: serviceLabel(t, note.service) })
    case 'waiting-for-stage':
      return t('gsxRoutines.note.waitingForStage', { services: serviceList(t, note.services) })
    case 'waiting-for-pilot':
      return t('gsxRoutines.note.waitingForPilot', { menu: note.menu })
    case 'waiting-for-fuel-entry':
      return fuelEntryText(t, note.gapKg)
    case 'waiting-for-payload-entry':
      return t('gsxRoutines.note.waitingForPayloadEntry')
    case 'entry-timed-out':
      return t('gsxRoutines.note.entryTimedOut')
    case 'following':
      return followingText(t, note.services)
    case 'stalled':
      return t('gsxRoutines.note.stalled', { services: serviceList(t, note.services) })
    case 'skipped':
      return t(`gsxRoutines.note.skipped.${SKIP_KEY[note.reason]}`, {
        service: serviceLabel(t, note.service)
      })
    default:
      return describeEndNote(t, note)
  }
}

/**
 * @param t The translator.
 * @param note The runner's status once the routine is ending or over.
 * @returns The status line in the pilot's language.
 */
function describeEndNote(
  t: TFunction,
  note: Extract<GsxRoutineNote, { code: 'ending' | 'ending-failed' | 'finished' | 'stopped' }>
): string {
  switch (note.code) {
    case 'ending':
      return t(`gsxRoutines.note.ending.${note.choice}`, { services: serviceList(t, note.services) })
    case 'ending-failed':
      return t('gsxRoutines.note.endingFailed', { services: serviceList(t, note.services) })
    case 'finished':
      return t('gsxRoutines.note.finished')
    case 'stopped':
      return t(`gsxRoutines.note.stopped.${STOP_KEY[note.reason]}`)
  }
}
