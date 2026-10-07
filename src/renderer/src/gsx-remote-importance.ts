/** Which GSX menus interrupt the whole app, and how a dismissed one is remembered. */

import type { GsxRemoteMenuState } from '@shared/ipc'

/**
 * Which GSX menus are important enough to interrupt the whole app, wherever the user
 * currently is — Callum's explicit call: pushback direction and fuel amount, nothing else
 * (handler choice, provider choice, the boarding→"attach pushback tug?" follow-up all stay
 * confined to the GSX tab, resolved by GSX's own default/timeout if nobody answers there).
 *
 * Matched on `menu.title`/`header` text — the real signal confirmed live, 2026-09-21
 * (winglog-backend's docs/gsx-notes.md): both cases are ordinary `state.menu` snapshots,
 * not a distinct "important" flag GSX exposes. Case-sensitive substring match against GSX's
 * own confirmed wording is deliberately narrow — a near-miss should fail open (treated as
 * not-important, stays on the GSX tab) rather than accidentally firing for an unrelated menu
 * that happens to share a word.
 */
const IMPORTANT_MENU_TITLES = ['Select pushback direction', 'Select refueling level']

/**
 * Whether this menu is open and is one of IMPORTANT_MENU_TITLES.
 *
 * @param menu GSX's current menu.
 * @returns True if it should prompt wherever the user is.
 */
export function isImportantGsxMenu(menu: GsxRemoteMenuState): boolean {
  // `menuShown` is a real, separate flag from having entries (docs/gsx-notes.md,
  // 2026-09-21) — entries can be stale/leftover while the menu itself is closed, so this
  // must gate on both, exactly like GSX's own client does.
  if (!menu.menuShown || menu.entries.length === 0) return false
  const title = menu.title || menu.header
  return IMPORTANT_MENU_TITLES.some((known) => title === known)
}

/**
 * Identifies a particular menu snapshot, so a user's dismissal of the global prompt can be
 * remembered until GSX actually shows something different (not re-shown for the exact same
 * still-unanswered menu, but shown again for a genuinely new one).
 *
 * @param menu GSX's current menu.
 * @returns Its signature.
 */
export function gsxMenuSignature(menu: GsxRemoteMenuState): string {
  return `${menu.title}|${menu.entries.join('\u0000')}`
}

/**
 * Whether the global GSX prompt is open, and which menu it is for.
 *
 * @param menu GSX's current menu, or null before the first.
 * @param onGsxTab Whether the GSX tab is showing, where the menu is answered in place.
 * @param dismissedKey The signature of the menu the user dismissed without answering, if any.
 * @returns `open`, true for an important menu the user hasn't dismissed while off the GSX tab; and `menuKey`, the important
 *   menu's signature (null when the menu isn't important), which a dismissal remembers.
 */
export function gsxPromptState(
  menu: GsxRemoteMenuState | null,
  onGsxTab: boolean,
  dismissedKey: string | null
): { open: boolean; menuKey: string | null } {
  const menuKey = menu && isImportantGsxMenu(menu) ? gsxMenuSignature(menu) : null
  return { open: !onGsxTab && menuKey !== null && menuKey !== dismissedKey, menuKey }
}
