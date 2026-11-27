/**
 * A paired device's name, the same rules on both sides (winglog-backend's docs/plans/devices-page.md, step 5): how long it may be and
 * which characters it may not hold. The main process cleans a name a device sends and refuses a rename that breaks them; Settings strips
 * them before sending a rename.
 */

/** The longest name a paired device can have, in characters. */
export const MAX_DEVICE_NAME = 40

/** Control characters (C0, C1), line and paragraph separators, and bidi controls and marks (ALM, LRM, RLM). */
const CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- finding control characters is what this is for
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/**
 * @param name A name.
 * @returns The name with every control, separator and bidi character removed.
 */
export function withoutControlCharacters(name: string): string {
  return name.replace(CONTROL_CHARACTERS, '')
}
