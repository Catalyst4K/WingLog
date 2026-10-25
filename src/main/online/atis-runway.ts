/**
 * The runway in use, read from an ATIS text, only when the text names exactly one (winglog-backend docs/plans/vatsim-build.md, Step 5).
 *
 * A 2026-10-25 read of VATSIM's feed found a single runway in about half of the ATIS texts; the rest name several runways, split
 * arrivals from departures, or name none. Those give no answer: a wrong runway is worse than none. The text is untrusted feed data, so
 * only a matched two-digit runway number and one letter ever leave this function.
 */

/** "RUNWAY", "RWY" or "[RWY]", an optional "IN USE", then a runway number and anything that continues it ("34L AND R", "27, 22"). */
const RUNWAY_MENTION =
  /\b(?:RUNWAYS?|RWYS?)\]?\s*(?:IN USE|IN OPERATION|ACTIVE)?\s*(?:IS|ARE|:)?\s*(\d{2}[LRC]?(?:(?:\s*(?:AND|,|&|\/)\s*(?:\d{2}[LRC]?|[LRC])|\s+\d{2}[LRC]?)\b)*)/g

/** A runway that is shut or unreliable makes the whole text too uncertain to name a runway from. */
const UNSAFE = /\b(?:CLOSED|CLSD|WIP|WORK IN PROGRESS|UNSERVICEABLE|U\/S|NOT AVAILABLE)\b/

/**
 * @param lines The ATIS's lines, as the network sent them.
 * @returns The one runway the text names (like "27L" or "09"), or null when it names none, several, or the text is unsafe to read.
 */
export function atisRunway(lines: string[]): string | null {
  // "30 LEFT" is 30L; read the word as its letter so the suggestion is not the wrong one of a parallel pair.
  const text = lines
    .join(' ')
    .toUpperCase()
    .replace(
      /\b(\d{2})\s+(LEFT|RIGHT|CENTRE|CENTER)\b/g,
      (_all, number: string, side: string) => number + side[0]
    )
  if (UNSAFE.test(text)) return null
  const named = new Set<string>()
  for (const match of text.matchAll(RUNWAY_MENTION)) {
    const group = match[1] ?? ''
    const runway = /^\d{2}[LRC]?/.exec(group)?.[0] ?? ''
    // Anything after the first runway ("34L AND R", "27, 22") means several.
    if (group.slice(runway.length).trim() !== '') return null
    const number = Number(runway.slice(0, 2))
    if (number < 1 || number > 36) return null
    named.add(runway)
  }
  return named.size === 1 ? ([...named][0] ?? null) : null
}
