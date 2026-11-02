/**
 * What the routine editor does to a routine's stages (winglog-backend's docs/plans/gsx-service-presets.md, "UI"): the default
 * layout when services are ticked, moving a service to another stage, and choosing what a stage waits for. Pure, so the
 * editor's rules are tested without rendering it. Every edit comes out valid by `checkRoutine`'s rules: no empty stage, no
 * repeated service, and a stage waits only for a service in an earlier stage.
 */
import {
  GSX_ROUTINE_NAME_MAX,
  routineServices,
  stageRoutine,
  type GsxRoutine,
  type GsxRoutineService,
  type GsxRoutineStage
} from '@shared/gsx-routines'

/**
 * Drops empty stages and any wait that no longer points at a service in an earlier stage. The first stage starts at once.
 *
 * @param stages Stages after an edit.
 * @returns Stages that pass validation.
 */
export function sanitizeStages(stages: readonly GsxRoutineStage[]): GsxRoutineStage[] {
  const kept = stages.filter((stage) => stage.services.length > 0)
  const earlier = new Set<GsxRoutineService>()
  return kept.map((stage, index) => {
    const startsWhen =
      index === 0 ? [] : stage.startsWhen.filter((condition) => earlier.has(condition.service))
    for (const service of stage.services) earlier.add(service)
    return { services: [...stage.services], startsWhen }
  })
}

/**
 * Ticks or unticks a service. The stages are laid out again with the default rule, so a hand-made order does not survive a
 * change to what is ticked.
 *
 * @param stages The routine's stages now.
 * @param service The service that was clicked.
 * @returns The stages for the new set of services.
 */
export function toggleService(
  stages: readonly GsxRoutineStage[],
  service: GsxRoutineService
): GsxRoutineStage[] {
  const ticked = routineServices({ stages })
  const next = ticked.includes(service) ? ticked.filter((s) => s !== service) : [...ticked, service]
  return stageRoutine(next)
}

/**
 * Moves a service to another stage, or to a new stage at the end.
 *
 * @param stages The routine's stages now.
 * @param service The service to move.
 * @param toStage The stage's position, or the number of stages for a new one at the end.
 * @returns The stages after the move.
 */
export function moveService(
  stages: readonly GsxRoutineStage[],
  service: GsxRoutineService,
  toStage: number
): GsxRoutineStage[] {
  const without = stages.map((stage) => ({
    ...stage,
    services: stage.services.filter((s) => s !== service)
  }))
  const target = Math.min(toStage, stages.length)
  const withService =
    target >= without.length
      ? [...without, { services: [service], startsWhen: [] }]
      : without.map((stage, index) =>
          index === target ? { ...stage, services: [...stage.services, service] } : stage
        )
  return sanitizeStages(withService)
}

/**
 * Chooses what a stage waits for: one completed service from an earlier stage, or nothing.
 *
 * @param stages The routine's stages now.
 * @param stageIndex The stage.
 * @param service The service it waits for, or null to start at once.
 * @returns The stages after the change; unchanged when the service is not in an earlier stage.
 */
export function setStartsWhen(
  stages: readonly GsxRoutineStage[],
  stageIndex: number,
  service: GsxRoutineService | null
): GsxRoutineStage[] {
  const earlier = stages.slice(0, stageIndex).flatMap((stage) => stage.services)
  if (service !== null && !earlier.includes(service)) return [...stages]
  return stages.map((stage, index) =>
    index === stageIndex
      ? { ...stage, startsWhen: service === null ? [] : [{ service, state: 'completed' as const }] }
      : stage
  )
}

/**
 * A new id for a routine of the pilot's own.
 *
 * @returns A random id of letters, digits and hyphens.
 */
export function newRoutineId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * A new routine of the pilot's own.
 *
 * @param id Its id.
 * @param name Its name.
 * @returns A routine with no services yet.
 */
export function blankRoutine(id: string, name: string): GsxRoutine {
  return { id, name, stages: [], answerGsxChoice: false, fuel: 'ask' }
}

/**
 * A copy of a routine for the pilot to change: a built-in is copied, never edited.
 *
 * @param routine The routine to copy.
 * @param id The copy's id.
 * @param name The copy's name, cut to the limit.
 * @returns The copy, without the built-in mark.
 */
export function copyRoutine(routine: GsxRoutine, id: string, name: string): GsxRoutine {
  return {
    id,
    name: name.slice(0, GSX_ROUTINE_NAME_MAX),
    stages: routine.stages.map((stage) => ({
      services: [...stage.services],
      startsWhen: stage.startsWhen.map((condition) => ({ ...condition }))
    })),
    answerGsxChoice: routine.answerGsxChoice,
    fuel: routine.fuel
  }
}

/**
 * @param routine A routine being edited.
 * @returns Why it cannot be saved yet, or null when it can.
 */
export function routineProblem(routine: GsxRoutine): 'name' | 'services' | null {
  if (routine.name.trim().length === 0 || routine.name.trim().length > GSX_ROUTINE_NAME_MAX) return 'name'
  if (routineServices(routine).length === 0) return 'services'
  return null
}
