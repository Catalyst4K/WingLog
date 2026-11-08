/**
 * The picture for a GSX routine replay (winglog-backend docs/plans/gsx-service-presets.md): one time axis with a lane per service
 * (the pilot's own recording above, the routine's below), the aircraft's fuel and zero fuel weight, and the data-entry guard's open
 * intervals. Drawn as SVG with the labels escaped.
 */
import { escapeHtml } from './svg'

const WIDTH = 760
const LEFT = 118
const RIGHT = 14
const LANE_H = 20
const CHART_H = 64
/** A line is never drawn over less than this range, so a weight that barely moves is drawn flat instead of as noise. */
const MIN_RANGE_KG = 400

export const RECORDED_COLOUR = '#868e96'
export const ROUTINE_COLOUR = '#1c7ed6'
export const GUARD_COLOUR = '#e8590c'
export const PICK_COLOUR = '#2f9e44'

export interface Bar {
  fromS: number
  toS: number
}

export interface Lane {
  label: string
  colour: string
  bars: Bar[]
}

export interface Marker {
  atS: number
  label: string
}

export interface Series {
  label: string
  colour: string
  /** [seconds, value] */
  points: [number, number][]
  /** Which top corner the label goes in, away from where the line is. */
  labelAt?: 'left' | 'right'
}

export interface TimelineFigure {
  fromS: number
  toS: number
  lanes: Lane[]
  guardLanes: Lane[]
  /** When the routine asked GSX for a service. */
  picks: Marker[]
  fuel: Series
  zfw: Series
}

/**
 * @param figure What to draw.
 * @returns The x position of a time.
 */
function xOf(figure: TimelineFigure): (t: number) => number {
  const span = Math.max(1, figure.toS - figure.fromS)
  return (t) =>
    LEFT + ((Math.min(Math.max(t, figure.fromS), figure.toS) - figure.fromS) / span) * (WIDTH - LEFT - RIGHT)
}

/**
 * @param figure The figure.
 * @param x The x scale.
 * @param height The height of the frame.
 * @returns Minute gridlines and their labels.
 */
function axis(figure: TimelineFigure, x: (t: number) => number, height: number): string {
  const first = Math.ceil(figure.fromS / 60)
  const last = Math.floor(figure.toS / 60)
  const step = last - first > 14 ? 2 : 1
  let out = ''
  for (let minute = first; minute <= last; minute += step) {
    const px = x(minute * 60)
    out += `<line x1="${px}" y1="0" x2="${px}" y2="${height}" stroke="currentColor" stroke-opacity="0.12"/>`
    out += `<text x="${px}" y="${height + 14}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity="0.7">${minute}</text>`
  }
  return (
    out +
    `<text x="${WIDTH - RIGHT}" y="${height + 28}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity="0.7">minutes into the recording</text>`
  )
}

/**
 * @param lane A lane.
 * @param y Its top.
 * @param x The x scale.
 * @returns The lane's label and bars.
 */
function laneSvg(lane: Lane, y: number, x: (t: number) => number): string {
  const bars = lane.bars
    .map(
      (b) =>
        `<rect x="${x(b.fromS)}" y="${y + 3}" width="${Math.max(2, x(b.toS) - x(b.fromS))}" height="${LANE_H - 8}" rx="3" fill="${lane.colour}" fill-opacity="0.85"/>`
    )
    .join('')
  return `<text x="${LEFT - 6}" y="${y + 13}" font-size="11" text-anchor="end" fill="currentColor">${escapeHtml(lane.label)}</text>${bars}`
}

/**
 * @param series A line to draw.
 * @param x The x scale.
 * @param top The top of its frame.
 * @param figure The figure, for the time range.
 * @returns The line, and its range written at the edge.
 */
function seriesSvg(series: Series, x: (t: number) => number, top: number, figure: TimelineFigure): string {
  const visible = series.points.filter(([t]) => t >= figure.fromS && t <= figure.toS)
  if (visible.length === 0) return ''
  const values = visible.map(([, v]) => v)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = Math.max(MIN_RANGE_KG, hi - lo)
  const mid = (hi + lo) / 2
  const base = mid - span / 2
  const y = (v: number): number => top + CHART_H - 6 - ((v - base) / span) * (CHART_H - 14)
  const d = visible
    .map(([t, v], i) => `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ')
  const label = `${series.label}  ${Math.round(lo).toLocaleString('en')} to ${Math.round(hi).toLocaleString('en')} kg`
  return `<rect x="${LEFT}" y="${top}" width="${WIDTH - LEFT - RIGHT}" height="${CHART_H}" fill="currentColor" fill-opacity="0.04"/>
<path d="${d}" fill="none" stroke="${series.colour}" stroke-width="1.6"/>
<text x="${series.labelAt === 'right' ? WIDTH - RIGHT - 4 : LEFT + 4}" y="${top + 11}" font-size="10" text-anchor="${series.labelAt === 'right' ? 'end' : 'start'}" fill="${series.colour}">${escapeHtml(label)}</text>`
}

/**
 * @param figure The figure.
 * @param x The x scale.
 * @param y The top of the strip.
 * @returns The picks, drawn as markers on a strip of their own with their labels.
 */
function picksSvg(figure: TimelineFigure, x: (t: number) => number, y: number): string {
  const marks = figure.picks
    .map((p, i) => {
      const px = x(p.atS)
      const row = i % 2
      return `<path d="M${px} ${y + 14} l-5 -9 h10 z" fill="${PICK_COLOUR}"/><text x="${px + 7}" y="${y + 10 + row * 11}" font-size="10" fill="currentColor">${escapeHtml(p.label)}</text>`
    })
    .join('')
  return `<text x="${LEFT - 6}" y="${y + 13}" font-size="11" text-anchor="end" fill="currentColor">routine asks</text>${marks}`
}

/**
 * @param figure What to draw.
 * @param caption What it shows.
 * @returns A figure element with the SVG and its caption.
 */
export function timelineFigure(figure: TimelineFigure, caption: string): string {
  const x = xOf(figure)
  const lanes = [...figure.lanes, ...figure.guardLanes]
  const lanesH = lanes.length * LANE_H
  const picksY = lanesH + 4
  const fuelTop = picksY + 40
  const zfwTop = fuelTop + CHART_H + 6
  const height = zfwTop + CHART_H
  const body = `${axis(figure, x, height)}${lanes.map((lane, i) => laneSvg(lane, i * LANE_H, x)).join('')}${picksSvg(figure, x, picksY)}${seriesSvg(figure.fuel, x, fuelTop, figure)}${seriesSvg(figure.zfw, x, zfwTop, figure)}`
  const svg = `<svg viewBox="0 0 ${WIDTH} ${height + 34}" width="100%" role="img" aria-label="${escapeHtml(caption)}" style="color:inherit">${body}</svg>`
  return `<figure>${svg}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
}
