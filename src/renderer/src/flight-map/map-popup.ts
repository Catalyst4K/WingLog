/** Map popups built from text nodes only. */
import { Popup, type Map as MapLibreMap } from 'maplibre-gl'

/** One line of a card: who, and on what frequency. */
export interface PopupCardRow {
  /** The kind of station, such as "CTR" or "ATIS L": aviation abbreviations stay in English. */
  tag: string
  callsign: string
  frequency: string
  /** The controller's name, when the network publishes it. */
  note: string | null
}

/** A title and a short table, for the ATC layer's popups. */
export interface PopupCard {
  title: string
  rows: PopupCardRow[]
}

/**
 * @param text The text.
 * @param style Inline styles: a popup lives in MapLibre's own DOM, outside the app's stylesheet.
 * @returns A span holding the text as a text node.
 */
function span(text: string, style: Partial<CSSStyleDeclaration>): HTMLSpanElement {
  const element = document.createElement('span')
  element.textContent = text
  Object.assign(element.style, style)
  return element
}

/**
 * Opens a card: a bold title, then one aligned row for each station (its kind, callsign and frequency, with the name beneath when there
 * is one). Built from text nodes only: the text came from a network feed, so none of it is ever parsed as HTML.
 *
 * @param map The map.
 * @param at Where the area or airport was clicked.
 * @param card The title and rows.
 * @returns The popup, for a caller that wants to take it away again.
 */
export function openCardPopup(map: MapLibreMap, at: { lng: number; lat: number }, card: PopupCard): Popup {
  const content = document.createElement('div')
  Object.assign(content.style, { minWidth: '230px', fontSize: '12px', lineHeight: '1.4' })
  const title = document.createElement('div')
  title.textContent = card.title
  // The right-hand padding keeps a long title clear of the cross in the corner.
  Object.assign(title.style, {
    fontWeight: '600',
    paddingRight: '16px',
    marginBottom: card.rows.length > 0 ? '6px' : '0'
  })
  content.appendChild(title)
  const grid = document.createElement('div')
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    columnGap: '10px',
    rowGap: '2px',
    alignItems: 'baseline'
  })
  const faint = { opacity: '0.65' }
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
  for (const row of card.rows) {
    grid.appendChild(span(row.tag, { ...faint, ...mono, fontSize: '11px' }))
    grid.appendChild(span(row.callsign, mono))
    grid.appendChild(span(row.frequency, { ...mono, fontWeight: '600', textAlign: 'right' }))
    if (row.note) {
      const note = span(row.note, { ...faint, gridColumn: '2 / -1', marginBottom: '2px' })
      grid.appendChild(note)
    }
  }
  content.appendChild(grid)
  const popup = new Popup({ closeButton: true, maxWidth: '320px' })
  popup.setLngLat(at).setDOMContent(content).addTo(map)
  return popup
}

/**
 * Opens a popup built from text nodes only: the lines came from a network feed, so none of it is ever parsed as HTML.
 *
 * @param map The map.
 * @param at Where the symbol was clicked.
 * @param lines The popup's lines; the first is the title.
 * @param maxWidth The popup's widest size, as CSS.
 */
export function openTextPopup(
  map: MapLibreMap,
  at: { lng: number; lat: number },
  lines: string[],
  maxWidth = '240px'
): void {
  const content = document.createElement('div')
  lines.forEach((line, index) => {
    const row = document.createElement('div')
    if (index === 0) Object.assign(row.style, { fontWeight: '600', paddingRight: '16px' })
    row.textContent = line
    content.appendChild(row)
  })
  new Popup({ closeButton: true, maxWidth }).setLngLat(at).setDOMContent(content).addTo(map)
}
