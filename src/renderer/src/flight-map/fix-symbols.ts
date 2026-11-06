/**
 * The route's fix symbols, by shape only, all hollow (winglog-backend docs/plans/v2-design.md, "The map"; the shapes are Callum's,
 * 2026-11-06): a circle for an en route fix, a hexagon for a SID or STAR fix, a triangle for an approach fix. Drawn once as SDF images, as the
 * traffic icon is, so one image takes the theme's quiet colour from the layer's `icon-color`.
 */
import type { Map as MapLibreMap } from 'maplibre-gl'

export const FIX_ENROUTE_ICON_ID = 'fix-enroute'
export const FIX_PROCEDURE_ICON_ID = 'fix-procedure'
export const FIX_APPROACH_ICON_ID = 'fix-approach'

/** The images are drawn at twice their size on screen and added with a pixel ratio of 2 so they stay sharp. */
const PIXEL_RATIO = 2
const LINE_WIDTH_PX = 1.4

type Draw = (context: CanvasRenderingContext2D, size: number) => void

/**
 * A triangle pointing up, as large as the box allows, with the outline inside it.
 *
 * @param context The canvas to draw on.
 * @param size The box's side, pixels.
 */
function triangle(context: CanvasRenderingContext2D, size: number): void {
  const inset = LINE_WIDTH_PX
  context.beginPath()
  context.moveTo(size / 2, inset)
  context.lineTo(size - inset, size - inset)
  context.lineTo(inset, size - inset)
  context.closePath()
  context.stroke()
}

/**
 * A ring.
 *
 * @param context The canvas to draw on.
 * @param size The box's side, pixels.
 */
function circle(context: CanvasRenderingContext2D, size: number): void {
  const centre = size / 2
  context.beginPath()
  context.arc(centre, centre, size / 2 - LINE_WIDTH_PX, 0, Math.PI * 2)
  context.stroke()
}

/**
 * A hexagon with a point at the top and the bottom.
 *
 * @param context The canvas to draw on.
 * @param size The box's side, pixels.
 */
function hexagon(context: CanvasRenderingContext2D, size: number): void {
  const centre = size / 2
  const radius = size / 2 - LINE_WIDTH_PX
  context.beginPath()
  for (let corner = 0; corner < 6; corner++) {
    const angle = -Math.PI / 2 + (corner * Math.PI) / 3
    const x = centre + radius * Math.cos(angle)
    const y = centre + radius * Math.sin(angle)
    if (corner === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
  context.stroke()
}

const SYMBOLS: { id: string; sizePx: number; draw: Draw }[] = [
  { id: FIX_ENROUTE_ICON_ID, sizePx: 8, draw: circle },
  { id: FIX_PROCEDURE_ICON_ID, sizePx: 12, draw: hexagon },
  { id: FIX_APPROACH_ICON_ID, sizePx: 11, draw: triangle }
]

/**
 * Adds the three fix symbols to the map, each unless it is there already.
 *
 * @param map The map.
 */
export function addFixSymbols(map: MapLibreMap): void {
  for (const symbol of SYMBOLS) {
    if (map.hasImage(symbol.id)) continue
    const side = symbol.sizePx * PIXEL_RATIO
    const canvas = document.createElement('canvas')
    canvas.width = side
    canvas.height = side
    const context = canvas.getContext('2d')
    // No 2D canvas (a test environment): the layer still exists, it just has no picture.
    if (!context) return
    context.scale(PIXEL_RATIO, PIXEL_RATIO)
    context.strokeStyle = '#ffffff'
    context.fillStyle = '#ffffff'
    context.lineWidth = LINE_WIDTH_PX
    context.lineJoin = 'round'
    symbol.draw(context, symbol.sizePx)
    map.addImage(symbol.id, context.getImageData(0, 0, side, side), { sdf: true, pixelRatio: PIXEL_RATIO })
  }
}
