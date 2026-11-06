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
  MapLayerMouseEvent,
  Popup
} from 'maplibre-gl'
import type { NetworkAtc, TrafficLayers } from '@shared/ipc'
import { useLiveClient } from './live/LiveClient'
import { reportError } from './report-error'
import { setSourceData } from './map-source'
import { atcPopupCard, layerData } from './flight-map/atc-features'
import { openCardPopup, type PopupCard } from './flight-map/map-popup'
import { mapPalette, type MapPalette } from './flight-map/map-palette'

/** What a GeoJSON source accepts as data. */
type GeoData = GeoJSONSourceSpecification['data']

export const ATC_AREAS_SOURCE = 'atc-areas'
export const ATC_LABELS_SOURCE = 'atc-area-labels'
export const ATC_AIRPORTS_SOURCE = 'atc-airports'
export const ATC_TOWERS_SOURCE = 'atc-towers'
export const ATC_FILL_LAYER = 'atc-areas-fill'
export const ATC_TOWER_FILL_LAYER = 'atc-towers-fill'
export const ATC_TOWER_LINE_LAYER = 'atc-towers-line'
export const ATC_LINE_LAYER = 'atc-areas-line'
export const ATC_APPROACH_LINE_LAYER = 'atc-approach-line'
export const ATC_CENTRE_LABEL_LAYER = 'atc-labels-centre'
export const ATC_APPROACH_LABEL_LAYER = 'atc-labels-approach'
export const ATC_AIRPORT_DOT_LAYER = 'atc-airports-dot'
export const ATC_AIRPORT_LETTERS_LAYER = 'atc-airports-letters'
const ALL_LAYERS = [
  ATC_FILL_LAYER,
  ATC_LINE_LAYER,
  ATC_APPROACH_LINE_LAYER,
  ATC_TOWER_FILL_LAYER,
  ATC_TOWER_LINE_LAYER,
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

// v2: every ATC area, ring and label is the palette's blue. A centre is tinted, an approach area lighter, a tower's ring only a hint,
// each of them clickable (a fill of no opacity is still hit by a click).

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
 * The edges of the areas: a centre has a solid edge, an approach area a dashed one, so the two read apart (with their tints).
 *
 * @param map The map.
 * @param palette The map's colours.
 * @param before The layer to go under, or undefined to go on top.
 */
function addAreaEdgeLayers(map: MapLibreMap, palette: MapPalette, before: string | undefined): void {
  map.addLayer(
    {
      id: ATC_LINE_LAYER,
      type: 'line',
      source: ATC_AREAS_SOURCE,
      filter: ['==', ['get', 'kind'], 'centre'] as FilterSpecification,
      paint: { 'line-color': palette.atc, 'line-width': 1.4 }
    },
    before
  )
  map.addLayer(
    {
      id: ATC_APPROACH_LINE_LAYER,
      type: 'line',
      source: ATC_AREAS_SOURCE,
      filter: ['==', ['get', 'kind'], 'approach'] as FilterSpecification,
      paint: { 'line-color': palette.atc, 'line-width': 1.2, 'line-dasharray': [3, 2] }
    },
    before
  )
}

/**
 * The ring round an airport with a tower: a thin dashed line, and a fill that is only there to be clicked.
 *
 * @param map The map.
 * @param palette The map's colours.
 * @param before The layer to go under, or undefined to go on top.
 */
function addTowerRingLayers(map: MapLibreMap, palette: MapPalette, before: string | undefined): void {
  map.addLayer(
    {
      id: ATC_TOWER_FILL_LAYER,
      type: 'fill',
      source: ATC_TOWERS_SOURCE,
      paint: { 'fill-color': palette.atc, 'fill-opacity': palette.atcFillOpacity * 0.4 }
    },
    before
  )
  map.addLayer(
    {
      id: ATC_TOWER_LINE_LAYER,
      type: 'line',
      source: ATC_TOWERS_SOURCE,
      paint: { 'line-color': palette.atc, 'line-width': 1.4, 'line-dasharray': [3, 2] }
    },
    before
  )
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
  map.addSource(ATC_TOWERS_SOURCE, { type: 'geojson', data: empty })
  const dark = document.documentElement.classList.contains('dark')
  const before = firstTrafficLayer(map)
  const palette = mapPalette(dark)
  const textPaint = (): Record<string, unknown> => ({
    'text-color': palette.atc,
    'text-halo-color': palette.halo,
    'text-halo-width': 1.2
  })
  map.addLayer(
    {
      id: ATC_FILL_LAYER,
      type: 'fill',
      source: ATC_AREAS_SOURCE,
      paint: {
        'fill-color': palette.atc,
        // Every area is tinted, so a click anywhere inside it lands on it: the approach areas lighter than the centres.
        'fill-opacity': [
          'case',
          ['==', ['get', 'kind'], 'centre'],
          palette.atcFillOpacity,
          palette.atcFillOpacity * 0.3
        ]
      } as never
    },
    before
  )
  addTowerRingLayers(map, palette, before)
  addAreaEdgeLayers(map, palette, before)
  const label = (id: string, kind: string, minzoom: number): void => {
    map.addLayer(
      {
        id,
        type: 'symbol',
        source: ATC_LABELS_SOURCE,
        minzoom,
        filter: ['==', ['get', 'kind'], kind] as FilterSpecification,
        layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-optional': true } as never,
        paint: textPaint() as never
      },
      before
    )
  }
  label(ATC_CENTRE_LABEL_LAYER, 'centre', CENTRE_LABEL_MINZOOM)
  label(ATC_APPROACH_LABEL_LAYER, 'approach', APPROACH_LABEL_MINZOOM)
  map.addLayer(
    {
      id: ATC_AIRPORT_DOT_LAYER,
      type: 'circle',
      source: ATC_AIRPORTS_SOURCE,
      minzoom: AIRPORT_MINZOOM,
      paint: {
        // The tower: a ring.
        'circle-radius': 4.5,
        'circle-color': palette.halo,
        'circle-stroke-color': palette.atc,
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
      paint: textPaint() as never
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
    return card
      ? [
          {
            card,
            approach: feature.properties?.kind === 'approach',
            tower: feature.properties?.kind === 'tower'
          }
        ]
      : []
  })
  // A shape the map has cut into tiles comes back once for each tile it spans.
  const unique = wanted.filter(
    ({ card }, index) => wanted.findIndex((one) => one.card.title === card.title) === index
  )
  const rank = (one: { tower: boolean; approach: boolean }): number => (one.tower ? 0 : one.approach ? 1 : 2)
  return [...unique].sort((a, b) => rank(a) - rank(b)).map((one) => one.card)
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
  // A click inside an area, a tower's ring or both is one click, and one card lists everything under it. The two layers each report it, so
  // the first one that gets it handles it and the other leaves it alone.
  const handled = new WeakSet<object>()
  const onArea =
    (other: string) =>
    (event: MapLayerMouseEvent): void => {
      if (event.originalEvent) {
        if (handled.has(event.originalEvent)) return
        handled.add(event.originalEvent)
      }
      const smaller = [ATC_AIRPORT_DOT_LAYER, ...TRAFFIC_LAYERS].filter((id) => map.getLayer(id))
      if (map.queryRenderedFeatures(event.point, { layers: smaller }).length > 0) return
      const alsoUnder = map.getLayer(other) ? map.queryRenderedFeatures(event.point, { layers: [other] }) : []
      open(event.lngLat, [...(event.features ?? []), ...alsoUnder])
    }
  map.on('click', ATC_FILL_LAYER, onArea(ATC_TOWER_FILL_LAYER))
  map.on('click', ATC_TOWER_FILL_LAYER, onArea(ATC_FILL_LAYER))
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
    setSourceData(map, ATC_TOWERS_SOURCE, data.towers as GeoData)
  }, [mapRef, mapReady, drawing, atc])

  return { atc }
}
