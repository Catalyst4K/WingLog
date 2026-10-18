/**
 * Identifier convention for the synthetic "Visual <runway>" approach (winglog-backend
 * docs/plans/visual-approach.md). Shared because the main process builds it and the
 * renderer's selector has to recognise it (e.g. to never auto-pick it over a real approach).
 */

const VISUAL_PREFIX = 'Visual '

/**
 * @param runwayIdent The runway, e.g. "27R".
 * @returns The visual approach's identifier, e.g. "Visual 27R".
 */
export function visualApproachIdentifier(runwayIdent: string): string {
  return `${VISUAL_PREFIX}${runwayIdent}`
}

/**
 * @param identifier An approach identifier, or null for none.
 * @returns True if it is a synthetic visual approach.
 */
export function isVisualApproach(identifier: string | null): boolean {
  return identifier !== null && identifier.startsWith(VISUAL_PREFIX)
}

/**
 * The runway of a visual identifier ("Visual 27R" → "27R"), or null for anything else.
 *
 * @param identifier An approach identifier.
 * @returns The runway, or null.
 */
export function visualApproachRunway(identifier: string): string | null {
  return isVisualApproach(identifier) ? identifier.slice(VISUAL_PREFIX.length) : null
}
