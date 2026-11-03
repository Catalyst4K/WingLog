/**
 * GSX routines (winglog-backend's docs/plans/gsx-service-presets.md): named presets that request a set of GSX services
 * with one button. This file is the data and the pure rules, shared by the PC, the runner and the phone: what a routine
 * is, the three built-ins, the staging rule that lays the ticked services out in a safe order, and the validation of
 * anything read back from storage or sent by the renderer.
 */

/** A service a routine can request: GSX's own service id, as `state.services[].id` carries it. Pushback and DeIce are
 *  deliberately not here (the plan: pushback belongs to the pilot, DeIce's follow-up menus were never recorded). */
export type GsxRoutineService =
  | 'Deboarding'
  | 'Cleaning'
  | 'Lavatory'
  | 'Water'
  | 'Catering'
  | 'Refueling'
  | 'Boarding'
  | 'GPU'
  | 'OperateJetways'

/** One stage: its services are requested one after another, once every `startsWhen` condition holds. */
export interface GsxRoutineStage {
  services: GsxRoutineService[]
  /** Each service must be in an earlier stage. A list of conditions so another kind could be added without changing saved routines. */
  startsWhen: { service: GsxRoutineService; state: 'completed' }[]
}

export type GsxRoutineBuiltIn = 'fenix-departure' | 'arrival' | 'turnaround-clean'

export interface GsxRoutine {
  /** Letters, digits and hyphens. */
  id: string
  /** 1 to 40 characters. */
  name: string
  /** Set on the three that ship with WingLog: they can be duplicated but not edited or deleted. */
  builtIn?: GsxRoutineBuiltIn
  stages: GsxRoutineStage[]
  /** Pick GSX's own `[GSX choice]` on a follow-up menu the routine caused (handling operator, catering operator). */
  answerGsxChoice: boolean
  /** What to do when GSX asks for the refuelling level: wait for the pilot, or pick the SimBrief block fuel entry. */
  fuel: 'ask' | 'simbrief-block'
}

export const GSX_ROUTINE_NAME_MAX = 40
const GSX_ROUTINE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/
/** More than the nine services could ever fill, so a stored file cannot make the editor or the runner huge. */
const GSX_ROUTINE_MAX_STAGES = 9
export const GSX_ROUTINES_MAX = 50

/** Where a service is requested from in GSX's menu, read from the recorded main menu (winglog-backend's docs/gsx-notes.md,
 *  "What twelve recorded flights say about routines"): the exact `Request …` label, and whether it is one level down under
 *  `Additional Services ▶`. A service is always found by this label, never by its position. */
export interface GsxRoutineMenuItem {
  label: string
  viaAdditionalServices: boolean
}

export const GSX_ROUTINE_MENU: Readonly<Record<GsxRoutineService, GsxRoutineMenuItem>> = {
  Deboarding: { label: 'Request Deboarding', viaAdditionalServices: false },
  Catering: { label: 'Request Catering service', viaAdditionalServices: false },
  Refueling: { label: 'Request Refueling', viaAdditionalServices: false },
  Boarding: { label: 'Request Boarding', viaAdditionalServices: false },
  OperateJetways: { label: 'Operate Jetway', viaAdditionalServices: false },
  GPU: { label: 'Request GPU', viaAdditionalServices: true },
  Lavatory: { label: 'Request Lavatory service', viaAdditionalServices: true },
  Water: { label: 'Request Water service', viaAdditionalServices: true },
  Cleaning: { label: 'Request Cleaning service', viaAdditionalServices: true }
}

/** Every service, in the order the editor lists them. */
export const GSX_ROUTINE_SERVICES = Object.keys(GSX_ROUTINE_MENU) as GsxRoutineService[]

/** The label of the submenu the `viaAdditionalServices` services sit under. */
export const GSX_ADDITIONAL_SERVICES_LABEL = 'Additional Services ▶'

/**
 * Whether a value is one of the services a routine can request.
 *
 * @param value Any value.
 * @returns True for a service id GSX routines know.
 */
export function isGsxRoutineService(value: unknown): value is GsxRoutineService {
  return typeof value === 'string' && (GSX_ROUTINE_SERVICES as string[]).includes(value)
}

/** The staging rule (Callum, 2026-10-05, answer 7): the order services are asked for, and the one service in an earlier tier
 *  a tier waits for. A tier whose service is not in the routine waits for nothing, so it starts with the first stage. */
const STAGING_TIERS: { services: GsxRoutineService[]; waitsFor: GsxRoutineService | null }[] = [
  { services: ['OperateJetways', 'GPU'], waitsFor: null },
  { services: ['Deboarding'], waitsFor: 'OperateJetways' },
  { services: ['Cleaning', 'Lavatory', 'Water'], waitsFor: 'Deboarding' },
  { services: ['Catering', 'Refueling'], waitsFor: 'Cleaning' },
  { services: ['Boarding'], waitsFor: 'Catering' }
]

/**
 * Lays services out in stages in the default order. Each stage waits only for a service that is in the routine; the
 * data-entry guard (Boarding against Refueling) is the runner's, not part of the stages.
 *
 * @param services The services ticked, in any order, repeats ignored.
 * @returns The stages, empty ones dropped; the first starts at once.
 */
export function stageRoutine(services: readonly GsxRoutineService[]): GsxRoutineStage[] {
  const wanted = new Set(services)
  const firstStage: GsxRoutineStage = { services: [], startsWhen: [] }
  const laterStages: GsxRoutineStage[] = []
  for (const tier of STAGING_TIERS) {
    const present = tier.services.filter((service) => wanted.has(service))
    if (present.length === 0) continue
    if (tier.waitsFor !== null && wanted.has(tier.waitsFor)) {
      laterStages.push({ services: present, startsWhen: [{ service: tier.waitsFor, state: 'completed' }] })
    } else {
      firstStage.services.push(...present)
    }
  }
  return firstStage.services.length > 0 ? [firstStage, ...laterStages] : laterStages
}

/**
 * Every service of a routine, stage by stage.
 *
 * @param routine The routine.
 * @returns Its services in the order its stages list them.
 */
export function routineServices(routine: { stages: readonly GsxRoutineStage[] }): GsxRoutineService[] {
  return routine.stages.flatMap((stage) => stage.services)
}

function builtIn(
  builtInId: GsxRoutineBuiltIn,
  name: string,
  services: GsxRoutineService[],
  answerGsxChoice: boolean
): GsxRoutine {
  return {
    id: `builtin-${builtInId}`,
    name,
    builtIn: builtInId,
    stages: stageRoutine(services),
    answerGsxChoice,
    fuel: 'ask'
  }
}

/** The three routines that ship (Callum, 2026-10-05). The turnaround reading is plan question 4's recommended one:
 *  Deboarding, then Cleaning, Lavatory and Water. */
export const BUILT_IN_ROUTINES: readonly GsxRoutine[] = [
  builtIn('fenix-departure', 'Departure', ['Catering', 'Refueling', 'Boarding'], false),
  builtIn('arrival', 'Arrival', ['OperateJetways', 'GPU', 'Deboarding'], false),
  builtIn('turnaround-clean', 'Turnaround clean', ['Deboarding', 'Cleaning', 'Lavatory', 'Water'], false)
]

export type GsxRoutineCheck = { ok: true; routine: GsxRoutine } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads one stage of a routine. A condition may only name a service in an earlier stage, so a stage can never wait for itself
 * or for something that is never requested.
 *
 * @param value The stage as stored or sent.
 * @param earlier The services of the stages before this one.
 * @param used The services seen so far in the routine, to refuse a repeat.
 * @returns The stage, or the reason it is refused.
 */
function checkStage(
  value: unknown,
  earlier: ReadonlySet<GsxRoutineService>,
  used: Set<GsxRoutineService>
): { stage: GsxRoutineStage } | { reason: string } {
  if (!isRecord(value) || !Array.isArray(value.services) || !Array.isArray(value.startsWhen)) {
    return { reason: 'a stage is not {services, startsWhen}' }
  }
  const services: GsxRoutineService[] = []
  for (const service of value.services) {
    if (!isGsxRoutineService(service)) return { reason: 'a stage names a service GSX routines do not have' }
    if (used.has(service)) return { reason: `${service} is in the routine twice` }
    used.add(service)
    services.push(service)
  }
  if (services.length === 0) return { reason: 'a stage has no services' }
  const startsWhen: GsxRoutineStage['startsWhen'] = []
  for (const condition of value.startsWhen) {
    if (!isRecord(condition) || condition.state !== 'completed' || !isGsxRoutineService(condition.service)) {
      return { reason: 'a stage waits for something that is not a completed service' }
    }
    if (!earlier.has(condition.service))
      return { reason: `a stage waits for ${condition.service}, which is not in an earlier stage` }
    startsWhen.push({ service: condition.service, state: 'completed' })
  }
  return { stage: { services, startsWhen } }
}

/**
 * Reads a routine's stages: 1 to 9, the first starting at once.
 *
 * @param value The stages as stored or sent.
 * @returns The stages, or the reason they are refused.
 */
function checkStages(value: unknown): { stages: GsxRoutineStage[] } | { reason: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > GSX_ROUTINE_MAX_STAGES) {
    return { reason: 'a routine has 1 to 9 stages' }
  }
  const stages: GsxRoutineStage[] = []
  const used = new Set<GsxRoutineService>()
  for (const [index, rawStage] of value.entries()) {
    const checked = checkStage(rawStage, new Set(used), used)
    if ('reason' in checked) return checked
    if (index === 0 && checked.stage.startsWhen.length > 0) return { reason: 'the first stage cannot wait' }
    stages.push(checked.stage)
  }
  return { stages }
}

/**
 * Reads a routine's id and name: an id that is safe to key on and that no built-in uses, and a name of 1 to 40 characters.
 *
 * @param record The routine as stored or sent.
 * @returns The id and the trimmed name, or the reason they are refused.
 */
function checkIdentity(record: Record<string, unknown>): { id: string; name: string } | { reason: string } {
  const { id } = record
  if (typeof id !== 'string' || !GSX_ROUTINE_ID_PATTERN.test(id)) return { reason: 'bad id' }
  if (BUILT_IN_ROUTINES.some((r) => r.id === id)) return { reason: 'the id belongs to a built-in routine' }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name.length === 0 || name.length > GSX_ROUTINE_NAME_MAX) {
    return { reason: `the name must be 1 to ${GSX_ROUTINE_NAME_MAX} characters` }
  }
  return { id, name }
}

/**
 * Checks a routine read from storage or sent by the renderer: external input, so nothing is trusted and nothing throws. A
 * stored routine can never be a built-in (those are code), so `builtIn` is dropped.
 *
 * @param value The routine as stored or sent.
 * @returns The routine as WingLog will keep it, or the reason it is refused.
 */
export function checkRoutine(value: unknown): GsxRoutineCheck {
  if (!isRecord(value)) return { ok: false, reason: 'not an object' }
  const identity = checkIdentity(value)
  if ('reason' in identity) return { ok: false, reason: identity.reason }
  if (typeof value.answerGsxChoice !== 'boolean') return { ok: false, reason: 'bad answerGsxChoice' }
  if (value.fuel !== 'ask' && value.fuel !== 'simbrief-block') return { ok: false, reason: 'bad fuel' }
  const checked = checkStages(value.stages)
  if ('reason' in checked) return { ok: false, reason: checked.reason }
  return {
    ok: true,
    routine: { ...identity, stages: checked.stages, answerGsxChoice: value.answerGsxChoice, fuel: value.fuel }
  }
}

/** What reading the stored routines found: the pilot's own routines that were valid, and a line for the log when anything was dropped. */
export interface StoredRoutines {
  routines: GsxRoutine[]
  problem: string | null
}

/**
 * Reads the stored `gsxRoutines` setting. A bad file, or a bad routine in it, never reaches the UI: the pilot keeps the
 * built-ins and whichever of their own routines are still valid.
 *
 * @param stored The setting's text, or undefined when never saved.
 * @returns The valid routines and, if anything was dropped, why.
 */
export function parseStoredRoutines(stored: string | undefined): StoredRoutines {
  if (stored === undefined || stored === '') return { routines: [], problem: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return { routines: [], problem: 'the stored routines are not valid JSON' }
  }
  if (!Array.isArray(parsed)) return { routines: [], problem: 'the stored routines are not a list' }
  const routines: GsxRoutine[] = []
  const reasons: string[] = []
  for (const item of parsed.slice(0, GSX_ROUTINES_MAX)) {
    const checked = checkRoutine(item)
    if (!checked.ok) reasons.push(checked.reason)
    else if (routines.some((r) => r.id === checked.routine.id)) reasons.push('a routine id is used twice')
    else routines.push(checked.routine)
  }
  if (parsed.length > GSX_ROUTINES_MAX) reasons.push(`more than ${GSX_ROUTINES_MAX} routines`)
  return {
    routines,
    problem: reasons.length > 0 ? `dropped ${reasons.length} stored routine(s): ${reasons.join('; ')}` : null
  }
}

/**
 * Reads the stored list of built-in routines the pilot has deleted. Anything that is not the id of a built-in is ignored.
 *
 * @param stored The setting's text, or undefined when never saved.
 * @returns The ids of the built-ins to leave out.
 */
export function parseHiddenBuiltIns(stored: string | undefined): string[] {
  if (stored === undefined || stored === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return BUILT_IN_ROUTINES.map((r) => r.id).filter((id) => parsed.includes(id))
}

/**
 * Every routine the pilot can start: the built-ins they have not deleted, then their own.
 *
 * @param own The pilot's own routines.
 * @param hiddenBuiltIns The ids of the built-ins the pilot deleted.
 * @returns The list shown on the GSX page and the phone.
 */
export function allRoutines(
  own: readonly GsxRoutine[],
  hiddenBuiltIns: readonly string[] = []
): GsxRoutine[] {
  return [...BUILT_IN_ROUTINES.filter((r) => !hiddenBuiltIns.includes(r.id)), ...own]
}
