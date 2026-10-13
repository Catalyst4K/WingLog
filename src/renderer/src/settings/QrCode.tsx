/** A QR code drawn as an SVG, always dark on white so it scans in either theme. */

import { useMemo } from 'react'
import { qrMatrix } from '../qr'

/** Light squares around the code that a scanner needs (the QR standard asks for four). */
const QUIET_ZONE = 4

/**
 * @param props The text the code holds, a description for screen readers, its size in pixels, and whether it is blurred and hidden
 *   from screen readers (a placeholder that is not to be scanned).
 * @returns The element.
 */
export function QrCode({
  text,
  label,
  size = 176,
  blurred = false
}: {
  text: string
  label: string
  size?: number
  blurred?: boolean
}): React.JSX.Element {
  const grid = useMemo(() => qrMatrix(text), [text])
  const span = grid.length + QUIET_ZONE * 2
  // One path: each run of dark squares along a row is a single rectangle.
  const path = grid
    .flatMap((row, y) => {
      const runs: string[] = []
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue
        let end = x
        while (end + 1 < row.length && row[end + 1]) end++
        runs.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x + 1}v1h${-(end - x + 1)}z`)
        x = end
      }
      return runs
    })
    .join('')
  return (
    <svg
      role={blurred ? undefined : 'img'}
      aria-label={blurred ? undefined : label}
      aria-hidden={blurred ? true : undefined}
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={blurred ? 'shrink-0 rounded-md blur-md select-none' : 'shrink-0 rounded-md'}
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
