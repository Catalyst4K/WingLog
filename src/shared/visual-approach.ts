/**
 * Identifier convention for the synthetic "Visual <runway>" approach (flightdeck-backend
 * docs/plans/visual-approach.md). Shared because the main process builds it and the
 * renderer's selector has to recognise it (e.g. to never auto-pick it over a real approach).
 */

const VISUAL_PREFIX = 'Visual '

export function visualApproachIdentifier(runwayIdent: string): string {
  return `${VISUAL_PREFIX}${runwayIdent}`
}

export function isVisualApproach(identifier: string | null): boolean {
  return identifier !== null && identifier.startsWith(VISUAL_PREFIX)
}

/** The runway of a visual identifier ("Visual 27R" → "27R"), or null for anything else. */
export function visualApproachRunway(identifier: string): string | null {
  return isVisualApproach(identifier) ? identifier.slice(VISUAL_PREFIX.length) : null
}
