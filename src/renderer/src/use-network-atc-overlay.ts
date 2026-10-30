/**
 * The Track map's ATC layer (winglog-backend docs/plans/online-atc-map.md): the staffed centre and approach areas of the chosen network,
 * shaded and labelled with their callsigns, and a marker at each airport with a staffed delivery, ground, tower or ATIS (the letters say
 * which). A click lists who is on it. On the PC and the phone alike (both give FlightMap a LiveClient).
 *
 * Main decides whether the layer draws (`trafficLayers.drawAtc`) and what is on it (`networkAtc`); this hook only draws. Nothing is added
 * to the map until the layer first draws, and switching off hides the layers rather than removing them. Under the traffic layers, so an
 * aircraft is never hidden by an area, and with its own attribution (the community data is CC BY-SA 4.0), shown while it is drawn.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type {
  FilterSpecification,
  GeoJSONSourceSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  Popup
} from 'maplibre-gl'
import type { NetworkAtc, TrafficLayers } from '@shared/ipc'
import { useLiveClient } from './live/LiveClient'
import { reportError } from './report-error'
import { setSourceData } from './map-source'
import { atcPopupCard, layerData } from './flight-map/atc-features'
import { openCardPopup, type PopupCard } from './flight-map/map-popup'

/** What a GeoJSON source accepts as data. */
type GeoData = GeoJSONSourceSpecification['data']

export const ATC_AREAS_SOURCE = 'atc-areas'
export const ATC_LABELS_SOURCE = 'atc-area-labels'
export const ATC_AIRPORTS_SOURCE = 'atc-airports'
export const ATC_FILL_LAYER = 'atc-areas-fill'
export const ATC_LINE_LAYER = 'atc-areas-line'
export const ATC_CENTRE_LABEL_LAYER = 'atc-labels-centre'
export const ATC_APPROACH_LABEL_LAYER = 'atc-labels-approach'
export const ATC_AIRPORT_DOT_LAYER = 'atc-airports-dot'
export const ATC_AIRPORT_LETTERS_LAYER = 'atc-airports-letters'
const ALL_LAYERS = [
  ATC_FILL_LAYER,
  ATC_LINE_LAYER,
  ATC_CENTRE_LABEL_LAYER,
  ATC_APPROACH_LABEL_LAYER,
  ATC_AIRPORT_DOT_LAYER,
  ATC_AIRPORT_LETTERS_LAYER
]

/** The two traffic layers' airborne symbols: the ATC layers go under the first of them that exists. */
const TRAFFIC_LAYERS = [
  'network-traffic-air',
  'network-traffic-ground',
  'sim-traffic-air',
  'sim-traffic-ground'
]

/** Centres are purple and approach areas pink: amber and teal are the two traffic layers', and blue the pilot's own aircraft. */
const CENTRE_COLOR = '#845ef7'
const APPROACH_COLOR = '#e64980'
const AIRPORT_COLOR = '#5f3dc4'
/** The dots are lighter on the dark map, where the dark purple all but disappears. */
const AIRPORT_COLOR_DARK = '#b197fc'

/** Zoom from which each kind of label and the airport letters appear, so a zoomed-out map is not a wall of text. */
const CENTRE_LABEL_MINZOOM = 3
const APPROACH_LABEL_MINZOOM = 7
const AIRPORT_MINZOOM = 4
const AIRPORT_LETTERS_MINZOOM = 7

/** What the ATC overlay hands the map's button and pill. */
export interface NetworkAtcOverlay {
  atc: NetworkAtc | null
}

export interface UseNetworkAtcOverlayArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only a live map shows ATC: a finished flight has no "now". */
  live: boolean
  /** The layers main says draw, from the traffic overlay (null before the topic arrives). */
  layers: TrafficLayers | null
}

/**
 * @param map The map.
 * @returns The first traffic layer already on it, which the ATC layers go under, or undefined to go on top.
 */
function firstTrafficLayer(map: MapLibreMap): string | undefined {
  return TRAFFIC_LAYERS.find((id) => map.getLayer(id))
}

/**
 * Adds the three sources and six layers once, and the click handlers that open a popup.
 *
 * @param map The map.
 */
function ensureAtcLayers(map: MapLibreMap): void {
  if (map.getSource(ATC_AREAS_SOURCE)) return
  const empty: GeoData = { type: 'FeatureCollection', features: [] }
  map.addSource(ATC_AREAS_SOURCE, {
    type: 'geojson',
    data: empty,
    attribution: 'ATC areas: VAT-Spy Data Project, SimAware TRACON Project (CC BY-SA 4.0)'
  })
  map.addSource(ATC_LABELS_SOURCE, { type: 'geojson', data: empty })
  map.addSource(ATC_AIRPORTS_SOURCE, { type: 'geojson', data: empty })
  const dark = document.documentElement.classList.contains('dark')
  const before = firstTrafficLayer(map)
  const kindColor = ['match', ['get', 'kind'], 'approach', APPROACH_COLOR, CENTRE_COLOR] as never
  const textPaint = (color: string, darkColor: string): Record<string, unknown> => ({
    'text-color': dark ? darkColor : color,
    'text-halo-color': dark ? '#0b0f14' : '#ffffff',
    'text-halo-width': 1.2
  })
  map.addLayer(
    {
      id: ATC_FILL_LAYER,
      type: 'fill',
      source: ATC_AREAS_SOURCE,
      paint: { 'fill-color': kindColor, 'fill-opacity': dark ? 0.14 : 0.1 }
    },
    before
  )
  map.addLayer(
    {
      id: ATC_LINE_LAYER,
      type: 'line',
      source: ATC_AREAS_SOURCE,
      paint: { 'line-color': kindColor, 'line-width': 1.2, 'line-opacity': 0.75 }
    },
    before
  )
  const label = (id: string, kind: string, minzoom: number, color: string, darkColor: string): void => {
    map.addLayer(
      {
        id,
        type: 'symbol',
        source: ATC_LABELS_SOURCE,
        minzoom,
        filter: ['==', ['get', 'kind'], kind] as FilterSpecification,
        layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-optional': true } as never,
        paint: textPaint(color, darkColor) as never
      },
      before
    )
  }
  label(ATC_CENTRE_LABEL_LAYER, 'centre', CENTRE_LABEL_MINZOOM, '#5f3dc4', '#d0bfff')
  label(ATC_APPROACH_LABEL_LAYER, 'approach', APPROACH_LABEL_MINZOOM, '#a61e4d', '#faa2c1')
  map.addLayer(
    {
      id: ATC_AIRPORT_DOT_LAYER,
      type: 'circle',
      source: ATC_AIRPORTS_SOURCE,
      minzoom: AIRPORT_MINZOOM,
      paint: {
        'circle-radius': 4.5,
        'circle-color': dark ? AIRPORT_COLOR_DARK : AIRPORT_COLOR,
        'circle-stroke-color': dark ? '#0b0f14' : '#ffffff',
        'circle-stroke-width': 1.5
      }
    },
    before
  )
  map.addLayer(
    {
      id: ATC_AIRPORT_LETTERS_LAYER,
      type: 'symbol',
      source: ATC_AIRPORTS_SOURCE,
      minzoom: AIRPORT_LETTERS_MINZOOM,
      layout: {
        'text-field': ['get', 'letters'],
        'text-size': 10,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-optional': true
      } as never,
      paint: textPaint('#5f3dc4', '#d0bfff') as never
    },
    before
  )
  addClickHandlers(map)
}

/**
 * @param features The features of one layer under a click, topmost first.
 * @returns Their cards, each once, the approaches ahead of the centres that cover them: where areas overlap, the click is on all of
 *   them, and a pilot looking for the approach frequency must not be shown only the centre over it.
 */
function cardsUnder(features: MapGeoJSONFeature[]): PopupCard[] {
  const wanted = features.flatMap((feature) => {
    const card = atcPopupCard(feature.properties ?? {})
    return card ? [{ card, approach: feature.properties?.kind === 'approach' }] : []
  })
  // A shape the map has cut into tiles comes back once for each tile it spans.
  const unique = wanted.filter(
    ({ card }, index) => wanted.findIndex((one) => one.card.title === card.title) === index
  )
  return [...unique.filter((one) => one.approach), ...unique.filter((one) => !one.approach)].map(
    (one) => one.card
  )
}

/**
 * A click on an airport's marker lists its stations; a click on an area, anywhere inside it, lists its controllers (every area there, where they overlap), unless something
 * smaller is under the click (an airport's marker, or an aircraft), which gets its own popup instead.
 *
 * @param map The map.
 */
function addClickHandlers(map: MapLibreMap): void {
  // The card on screen, so that a second click on the same airport or area takes it away again.
  let shown: { popup: Popup; key: string } | null = null
  const open = (at: { lng: number; lat: number }, features: MapGeoJSONFeature[] | undefined): void => {
    const cards = cardsUnder(features ?? [])
    if (cards.length === 0) return
    const key = cards.map((card) => card.title).join('|')
    if (shown?.key === key && shown.popup.isOpen()) {
      shown.popup.remove()
      shown = null
      return
    }
    shown = { popup: openCardPopup(map, at, cards), key }
  }
  map.on('click', ATC_AIRPORT_DOT_LAYER, (event) => open(event.lngLat, event.features))
  map.on('click', ATC_FILL_LAYER, (event) => {
    const smaller = [ATC_AIRPORT_DOT_LAYER, ...TRAFFIC_LAYERS].filter((id) => map.getLayer(id))
    if (map.queryRenderedFeatures(event.point, { layers: smaller }).length > 0) return
    open(event.lngLat, event.features)
  })
  // The canvas's own cursor beats the container's (the grab hand, or the arrow while panning is locked).
  map.on('mouseenter', ATC_AIRPORT_DOT_LAYER, () => {
    map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', ATC_AIRPORT_DOT_LAYER, () => {
    map.getCanvas().style.cursor = ''
  })
}

/**
 * Shows or hides the layers.
 *
 * @param map The map.
 * @param visible Whether they should be seen.
 */
function setVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of ALL_LAYERS)
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

/**
 * Follows the `networkAtc` topic and draws the layer while main says to.
 *
 * @param args The map, whether it is ready and live, and the layers main says draw.
 * @returns The topic's latest value, for the map's button and pill.
 */
export function useNetworkAtcOverlay({
  mapRef,
  mapReady,
  live,
  layers
}: UseNetworkAtcOverlayArgs): NetworkAtcOverlay {
  const client = useLiveClient()
  const [atc, setAtc] = useState<NetworkAtc | null>(null)
  const createdRef = useRef(false)

  useEffect(() => {
    if (!live) return
    let current = true
    try {
      client.get('networkAtc').then(
        (value) => current && value && setAtc(value),
        (error: unknown) => reportError('map: ATC', error)
      )
      const unsubscribe = client.subscribe('networkAtc', setAtc)
      return () => {
        current = false
        unsubscribe()
      }
    } catch (error) {
      reportError('map: ATC subscribe', error)
      return undefined
    }
  }, [client, live])

  const drawing = live && layers?.drawAtc === true && atc?.state === 'shown'
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (!drawing) {
      if (createdRef.current) setVisible(map, false)
      return
    }
    if (!createdRef.current) {
      ensureAtcLayers(map)
      createdRef.current = true
    }
    setVisible(map, true)
    const data = layerData(atc)
    setSourceData(map, ATC_AREAS_SOURCE, data.areas as GeoData)
    setSourceData(map, ATC_LABELS_SOURCE, data.labels as GeoData)
    setSourceData(map, ATC_AIRPORTS_SOURCE, data.airports as GeoData)
  }, [mapRef, mapReady, drawing, atc])

  return { atc }
}
