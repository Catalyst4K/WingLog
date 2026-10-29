import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { AtcAirport, AtcArea, NetworkAtc, TrafficLayers } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from './live/LiveClient'

const popups: { lngLat: unknown; content: HTMLElement | null }[] = []

vi.mock('maplibre-gl', () => ({
  Popup: class {
    state: { lngLat: unknown; content: HTMLElement | null } = { lngLat: null, content: null }
    constructor() {
      popups.push(this.state)
    }
    setLngLat(at: unknown): this {
      this.state.lngLat = at
      return this
    }
    setDOMContent(content: HTMLElement): this {
      this.state.content = content
      return this
    }
    addTo(): this {
      return this
    }
  }
}))

const {
  useNetworkAtcOverlay,
  ATC_AREAS_SOURCE,
  ATC_LABELS_SOURCE,
  ATC_AIRPORTS_SOURCE,
  ATC_FILL_LAYER,
  ATC_AIRPORT_DOT_LAYER
} = await import('./use-network-atc-overlay')

interface FakeLayer {
  id: string
  type: string
  source: string
  minzoom?: number
}

function fakeMap(existing: string[] = []) {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn>; spec: Record<string, unknown> }>()
  const layers = new Map<string, FakeLayer>(existing.map((id) => [id, { id, type: 'symbol', source: 'x' }]))
  const placedBefore = new Map<string, string | undefined>()
  const visibility = new Map<string, string>()
  const clicks = new Map<string, (event: unknown) => void>()
  const hovers = new Map<string, () => void>()
  const canvas = { style: { cursor: '' } }
  let underClick: string[] = []
  const map = {
    getCanvas: () => canvas,
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string, spec: Record<string, unknown>) => {
      sources.set(id, { setData: vi.fn().mockResolvedValue(undefined), spec })
    }),
    addLayer: vi.fn((layer: FakeLayer, before?: string) => {
      layers.set(layer.id, layer)
      placedBefore.set(layer.id, before)
    }),
    getLayer: (id: string) => layers.get(id),
    setLayoutProperty: vi.fn((id: string, name: string, value: string) => {
      if (name === 'visibility') visibility.set(id, value)
    }),
    queryRenderedFeatures: vi.fn(() => underClick.map((id) => ({ layer: { id } }))),
    on: vi.fn((event: string, layerId: string, handler: (event: unknown) => void) => {
      if (event === 'click') clicks.set(layerId, handler)
      else hovers.set(`${event}:${layerId}`, handler as () => void)
    })
  }
  return {
    map,
    sources,
    layers,
    placedBefore,
    visibility,
    clicks,
    hovers,
    canvas,
    putUnderClick: (ids: string[]) => {
      underClick = ids
    }
  }
}

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  simOffered: true,
  atcOn: false,
  drawNetwork: false,
  drawSim: false,
  drawAtc: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, atcOn: true, drawAtc: true }

const SQUARE = [
  [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0]
    ]
  ]
]
const CENTRE: AtcArea = {
  id: 'EGTT-C',
  kind: 'centre',
  name: 'London ACC (Central) - London',
  at: [-0.15, 52.178],
  coordinates: SQUARE,
  stations: [{ callsign: 'LON_C_CTR', frequency: '133.700', position: 'ctr', name: null }]
}
const HEATHROW: AtcAirport = {
  icao: 'EGLL',
  at: [-0.4619, 51.4706],
  stations: [{ callsign: 'EGLL_TWR', frequency: '118.500', position: 'twr', name: null }],
  atis: []
}

function shown(areas: AtcArea[] = [CENTRE], airports: AtcAirport[] = [HEATHROW]): NetworkAtc {
  return { network: 'vatsim', state: 'shown', areas, airports }
}

function fakeClient(initial: { atc?: NetworkAtc }) {
  const listeners = new Map<LiveTopic, (payload: never) => void>()
  const client: LiveClient = {
    get: vi.fn((topic: LiveTopic) =>
      Promise.resolve(topic === 'networkAtc' ? initial.atc : undefined)
    ) as LiveClient['get'],
    subscribe: vi.fn((topic: LiveTopic, listener: (payload: never) => void) => {
      listeners.set(topic, listener)
      return () => listeners.delete(topic)
    }) as LiveClient['subscribe'],
    command: vi.fn().mockResolvedValue(undefined)
  }
  const push = <T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void =>
    listeners.get(topic)?.(payload as never)
  return { client, push }
}

async function mount(
  client: LiveClient,
  fake: ReturnType<typeof fakeMap>,
  options: { live?: boolean; mapReady?: boolean; layers?: TrafficLayers | null } = {}
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  )
  const mapRef = { current: fake.map as never }
  const view = renderHook(
    (props: { layers: TrafficLayers | null }) =>
      useNetworkAtcOverlay({
        mapRef,
        mapReady: options.mapReady ?? true,
        live: options.live ?? true,
        layers: props.layers
      }),
    { wrapper, initialProps: { layers: options.layers === undefined ? LAYERS_ON : options.layers } }
  )
  await act(async () => {})
  return view
}

/** The features last written to a source. */
function lastFeatures(
  fake: ReturnType<typeof fakeMap>,
  sourceId: string
): { properties: Record<string, unknown> }[] {
  const calls = fake.sources.get(sourceId)?.setData.mock.calls ?? []
  return (calls.at(-1)?.[0] as { features: never[] } | undefined)?.features ?? []
}

describe('useNetworkAtcOverlay', () => {
  beforeEach(() => {
    popups.length = 0
  })
  afterEach(() => vi.clearAllMocks())

  it('touches nothing on the map until the layer first draws', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { layers: LAYERS_OFF })
    expect(fake.map.addSource).not.toHaveBeenCalled()
    expect(fake.map.addLayer).not.toHaveBeenCalled()
    expect(fake.map.setLayoutProperty).not.toHaveBeenCalled()
  })

  it('does nothing on a map that is not live, and does not even subscribe', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { live: false })
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('waits for the map to be ready, and for the layers to say it draws', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { mapReady: false })
    await mount(client, fake, { layers: null })
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('adds three sources and six layers once, with the licence’s attribution on the areas', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake)
    expect([...fake.sources.keys()]).toEqual([ATC_AREAS_SOURCE, ATC_LABELS_SOURCE, ATC_AIRPORTS_SOURCE])
    expect([...fake.layers.keys()]).toEqual([
      'atc-areas-fill',
      'atc-areas-line',
      'atc-labels-centre',
      'atc-labels-approach',
      'atc-airports-dot',
      'atc-airports-letters'
    ])
    expect(fake.sources.get(ATC_AREAS_SOURCE)?.spec.attribution).toMatch(/CC BY-SA 4\.0/)
    expect(fake.sources.get(ATC_AREAS_SOURCE)?.spec.attribution).toMatch(/VAT-Spy/)
  })

  it('draws the areas, their labels and the airports', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake)
    expect(lastFeatures(fake, ATC_AREAS_SOURCE).map((f) => f.properties.kind)).toEqual(['centre'])
    expect(lastFeatures(fake, ATC_LABELS_SOURCE).map((f) => f.properties.label)).toEqual(['LON_C_CTR'])
    expect(
      lastFeatures(fake, ATC_AIRPORTS_SOURCE).map((f) => [f.properties.label, f.properties.letters])
    ).toEqual([['EGLL', 'T']])
  })

  it('goes under the traffic layers when they are already on the map, and on top when they are not', async () => {
    const under = fakeMap(['network-traffic-air', 'sim-traffic-air'])
    await mount(fakeClient({ atc: shown() }).client, under)
    for (const id of ['atc-areas-fill', 'atc-airports-dot', 'atc-airports-letters'])
      expect(under.placedBefore.get(id)).toBe('network-traffic-air')
    const alone = fakeMap()
    await mount(fakeClient({ atc: shown() }).client, alone)
    expect(alone.placedBefore.get('atc-areas-fill')).toBeUndefined()
  })

  it('follows the topic: a new set of controllers is drawn, and nothing is added twice', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ atc: shown() })
    await mount(client, fake)
    await act(async () => push('networkAtc', shown([], [HEATHROW, { ...HEATHROW, icao: 'EGKK' }])))
    expect(lastFeatures(fake, ATC_AREAS_SOURCE)).toEqual([])
    expect(lastFeatures(fake, ATC_AIRPORTS_SOURCE).map((f) => f.properties.label)).toEqual(['EGLL', 'EGKK'])
    expect(fake.map.addSource).toHaveBeenCalledTimes(3)
  })

  it('hides the layers when the layers say it no longer draws, and shows them again', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    const view = await mount(client, fake)
    view.rerender({ layers: LAYERS_OFF })
    expect(fake.visibility.get('atc-areas-fill')).toBe('none')
    expect(fake.visibility.get('atc-airports-letters')).toBe('none')
    view.rerender({ layers: LAYERS_ON })
    expect(fake.visibility.get('atc-areas-fill')).toBe('visible')
    expect(fake.map.addSource).toHaveBeenCalledTimes(3)
  })

  it.each([['off'], ['noNetwork'], ['needsVid'], ['unavailable']] as const)(
    'draws nothing while the topic says %s',
    async (state) => {
      const fake = fakeMap()
      const { client } = fakeClient({ atc: { network: 'vatsim', state, areas: [], airports: [] } })
      await mount(client, fake)
      expect(fake.map.addSource).not.toHaveBeenCalled()
    }
  )

  it('returns the topic, for the button and the pill', async () => {
    const { client } = fakeClient({ atc: shown() })
    const view = await mount(client, fakeMap())
    expect(view.result.current.atc?.state).toBe('shown')
  })

  describe('clicks', () => {
    async function drawn() {
      const fake = fakeMap()
      await mount(fakeClient({ atc: shown() }).client, fake)
      return fake
    }
    const featureWith = (lines: string[]) => ({ properties: { lines: JSON.stringify(lines) } })

    it('lists the controllers of an area in a popup of text nodes', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [featureWith(['London ACC', '<b>LON_C_CTR 133.700</b>'])]
      })
      expect(popups).toHaveLength(1)
      expect(popups[0]?.content?.textContent).toBe('London ACC<b>LON_C_CTR 133.700</b>')
      expect(popups[0]?.content?.querySelector('b')).toBeNull()
    })

    it('lists the stations of an airport', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [featureWith(['EGLL', 'EGLL_TWR 118.500'])]
      })
      expect(popups[0]?.content?.textContent).toBe('EGLLEGLL_TWR 118.500')
    })

    it('leaves a click on an airport’s marker or an aircraft to them, not the area under it', async () => {
      const fake = await drawn()
      for (const under of [[ATC_AIRPORT_DOT_LAYER], ['network-traffic-air']]) {
        fake.layers.set('network-traffic-air', { id: 'network-traffic-air', type: 'symbol', source: 'x' })
        fake.putUnderClick(under)
        fake.clicks.get(ATC_FILL_LAYER)?.({
          lngLat: { lng: 1, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith(['London ACC'])]
        })
      }
      expect(popups).toHaveLength(0)
    })

    it('opens nothing for a feature with no lines', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 1, y: 1 },
        features: [{ properties: {} }]
      })
      fake.clicks.get(ATC_FILL_LAYER)?.({ lngLat: { lng: 1, lat: 2 }, point: { x: 1, y: 1 } })
      expect(popups).toHaveLength(0)
    })

    it('shows the pointing hand over an airport’s marker, and puts it back', async () => {
      const fake = await drawn()
      fake.hovers.get(`mouseenter:${ATC_AIRPORT_DOT_LAYER}`)?.()
      expect(fake.canvas.style.cursor).toBe('pointer')
      fake.hovers.get(`mouseleave:${ATC_AIRPORT_DOT_LAYER}`)?.()
      expect(fake.canvas.style.cursor).toBe('')
    })
  })
})
