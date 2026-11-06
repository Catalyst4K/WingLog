/**
 * Reading GSX's menu for a routine (winglog-backend's docs/gsx-notes.md, "What twelve recorded flights say about routines"):
 * which menu is open, where an entry is, and what to do with a follow-up menu GSX opens by itself. All pure.
 *
 * `menu.pick` is only an index into whatever menu is open, so a routine finds an entry by its exact label and the runner
 * checks the title and the label again just before the pick is sent.
 */
import type { GsxRemoteMenuState } from '@shared/ipc'

const MAIN_MENU_TITLE_PREFIX = 'Activate Services at'
const ADDITIONAL_SERVICES_TITLE_PREFIX = 'Additional Services'
const SERVICE_IN_PROGRESS_TITLE = 'Service in progress'
/** The two entries of GSX's `Service in progress` menu (it also has `Back`), picked by their exact labels. */
export const COMPLETE_NOW_LABEL = 'Complete now'
export const ABORT_SERVICE_LABEL = 'Abort service'
const GSX_CHOICE_MARK = '[GSX choice]'
const REFUELING_LEVEL_TITLE_PREFIX = 'Select refueling level'
const SIMBRIEF_BLOCK_FUEL_MARK = 'BLOCK FUEL from Simbrief'
const DEFUEL_MARK = '[DEFUEL]'
/** Pushback belongs to the pilot (the plan), and its tug question carries a `[GSX choice]` too, so it is never answered. */
const PUSHBACK_MENU = /push ?back|tug/i

/**
 * @param menu GSX's menu.
 * @returns Whether the main menu, `Activate Services at …`, is open.
 */
export function isMainMenu(menu: GsxRemoteMenuState): boolean {
  return menu.menuShown && menu.title.startsWith(MAIN_MENU_TITLE_PREFIX)
}

/**
 * @param menu GSX's menu.
 * @returns Whether the `Additional Services` submenu is open.
 */
export function isAdditionalServicesMenu(menu: GsxRemoteMenuState): boolean {
  return menu.menuShown && menu.title.startsWith(ADDITIONAL_SERVICES_TITLE_PREFIX)
}

/**
 * @param menu GSX's menu.
 * @returns Whether `Service in progress` is open: what GSX shows when a running service's own entry is picked. It does not say
 *   which service it is for.
 */
export function isServiceInProgressMenu(menu: GsxRemoteMenuState): boolean {
  return menu.menuShown && menu.title === SERVICE_IN_PROGRESS_TITLE
}

/**
 * @param menu The open menu.
 * @param label An entry's exact label.
 * @returns The entry's position, or -1 when the menu has no entry with exactly this label.
 */
export function findEntry(menu: GsxRemoteMenuState, label: string): number {
  return menu.entries.indexOf(label)
}

/**
 * @param menu The open menu.
 * @param labels The exact labels a service can have, in the order to prefer them.
 * @returns The position of the first label the menu has, or -1 when it has none of them.
 */
export function findAnyEntry(menu: GsxRemoteMenuState, labels: readonly string[]): number {
  for (const label of labels) {
    const index = findEntry(menu, label)
    if (index >= 0) return index
  }
  return -1
}

/**
 * @param menu The open menu.
 * @param index An entry's position.
 * @returns Whether GSX shows the entry greyed out.
 */
export function isEntryDisabled(menu: GsxRemoteMenuState, index: number): boolean {
  return menu.disabled[index] === true
}

/**
 * @param menu GSX's menu.
 * @returns Whether it is the refuelling level menu, which opens by itself once the fuel truck is in position.
 */
export function isRefuelingLevelMenu(menu: GsxRemoteMenuState): boolean {
  return menu.menuShown && menu.title.startsWith(REFUELING_LEVEL_TITLE_PREFIX)
}

/** What to do with a menu GSX opened by itself. */
export type FollowUpDecision =
  | { kind: 'pick'; index: number; label: string }
  /** Leave it to the pilot: it is shown on the GSX page as it is. */
  | { kind: 'wait'; title: string }

export interface FollowUpContext {
  /** The routine's "answer GSX's own default" option. */
  answerGsxChoice: boolean
  /** The routine stores "SimBrief block fuel" and has asked for Refueling. */
  pickBlockFuel: boolean
  /** The menu opened within a couple of seconds of the routine's own pick, so it is the routine's follow-up. */
  followsOwnPick: boolean
}

/**
 * Decides a follow-up menu (Callum's answer 2, 2026-10-05):
 * - the refuelling level, whenever it opens: only the SimBrief block fuel entry, and only when the routine stores that choice;
 *   never an entry marked as a defuel;
 * - a menu that follows the routine's own pick and has GSX's default marked: that default, when the routine answers for GSX;
 * - anything else is the pilot's, and the pushback tug question is never answered.
 *
 * @param menu The open follow-up menu.
 * @param context What the routine has said it will answer.
 * @returns The entry to pick, or to wait.
 */
export function decideFollowUp(menu: GsxRemoteMenuState, context: FollowUpContext): FollowUpDecision {
  const wait: FollowUpDecision = { kind: 'wait', title: menu.title }
  if (isRefuelingLevelMenu(menu)) {
    if (!context.pickBlockFuel) return wait
    const index = menu.entries.findIndex((entry) => entry.includes(SIMBRIEF_BLOCK_FUEL_MARK))
    const label = menu.entries[index]
    if (index < 0 || isEntryDisabled(menu, index) || label.includes(DEFUEL_MARK)) return wait
    return { kind: 'pick', index, label }
  }
  if (context.answerGsxChoice && context.followsOwnPick && !PUSHBACK_MENU.test(menu.title)) {
    const index = menu.entries.findIndex((entry) => entry.includes(GSX_CHOICE_MARK))
    if (index >= 0 && !isEntryDisabled(menu, index))
      return { kind: 'pick', index, label: menu.entries[index] }
  }
  return wait
}
